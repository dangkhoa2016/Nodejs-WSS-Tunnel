#!/usr/bin/env bash
set -euo pipefail

# =============================================================================
# Tunnel Client Installer - service host (Computer A)
#
# Installs or upgrades the tunnel client on the host that owns the TCP
# services (Redis, PostgreSQL, ...). The install is transactional:
#
#   stage new release (download + validate + install deps)
#       -> only then stop the old process
#       -> activate new release
#       -> wait for readiness
#       -> on failure, roll back to the previous release
#
# Rollback captures the running process's environment from /proc/$pid/environ
# (Linux only).  On non-Linux platforms, set ALLOW_CODE_ONLY_ROLLBACK=1 to
# roll back using the previous code with the current installer's runtime
# configuration (does not restore the previous process environment).
#
# Releases live under $WORK_DIR/releases/release.<random>/, the active one is
# symlinked as $WORK_DIR/current and the previous one as $WORK_DIR/previous.
#
# Required env:
#   SERVER_HOST       hostname[:port] of the tunnel server (no scheme/path)
#   INSTALL_UUID      uuid pinned on the server (used in artifact URLs)
#   TUNNEL_USERNAME / TUNNEL_PASSWORD   (or interactive prompt)
#
# Optional env:
#   CLIENT_DIR                    work dir (default ~/.tunnel-client)
#   TCP_TUNNEL_HOST               service bind address the client forwards to
#   CLIENT_BUNDLE_URL             override bundle URL (https only by default)
#   CLIENT_MANIFEST_URL           override manifest URL (https only by default)
#   CLIENT_BUNDLE_PATH            use a local bundle file instead of downloading
#   ALLOW_INSECURE_BUNDLE_URL=1   allow http:// artifact URLs (local dev only)
#   ALLOW_FALLBACK_MANIFEST=1     write a fallback manifest if fetch fails
#   INSTALL_RELEASES_KEEP         releases to keep after success (default 3)
#   SETUP_LOG_KEEP                rotated log files to keep (default 5)
#   TUNNEL_READY_TIMEOUT_SECS     readiness timeout (default 20)
#   TUNNEL_ROLLBACK_TIMEOUT_SECS  rollback readiness timeout (default 15)
#   ALLOW_CODE_ONLY_ROLLBACK=1    allow proceeding when the previous runtime
#                                 config cannot be captured (rollback uses
#                                 previous code + current config instead)
#
# Rollback contract: an upgrade rolls back to the previous release (code) AND
# the previous runtime config (deployment rollback). The previous config is
# captured in memory from /proc/<old_pid>/environ before the old process is
# stopped, so a bad credential or service change cannot break the rollback. If
# the environment cannot be read, the installer refuses to stop the running
# process unless ALLOW_CODE_ONLY_ROLLBACK=1 is set.
#
# Supported platform: Linux with GNU coreutils/findutils (find -printf,
# sort -z, cut -z). On macOS install the GNU tools and put them on PATH.
#
# Exit codes: 0 success, nonzero on any failure (including a failed upgrade
# that rolled back, so callers can tell the desired release did not land).
# =============================================================================

umask 077

ROLE="client"
ROLE_JS="client.js"

SERVER_HOST="${SERVER_HOST:-}"
INSTALL_UUID="${INSTALL_UUID:-}"
WORK_DIR="${CLIENT_DIR:-$HOME/.tunnel-client}"
SERVICE_HOST="${TCP_TUNNEL_HOST:-127.0.0.1}"
INSTALL_RELEASES_KEEP="${INSTALL_RELEASES_KEEP:-3}"
SETUP_LOG_KEEP="${SETUP_LOG_KEEP:-5}"
TUNNEL_READY_TIMEOUT_SECS="${TUNNEL_READY_TIMEOUT_SECS:-20}"
TUNNEL_ROLLBACK_TIMEOUT_SECS="${TUNNEL_ROLLBACK_TIMEOUT_SECS:-15}"

RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'; NC='\033[0m'
info()  { printf "${GREEN}[service-host]${NC} %s\n" "$*"; }
warn()  { printf "${YELLOW}[service-host]${NC} %s\n" "$*" >&2; }
error() { printf "${RED}[service-host]${NC} %s\n" "$*" >&2; }
die()   { error "$*"; exit 1; }

# ---------------------------------------------------------------------------
# Configuration validation
# ---------------------------------------------------------------------------

validate_server_host() {
  [ -n "$SERVER_HOST" ] || die 'SERVER_HOST is required and must be shared with every application host'
  case "$SERVER_HOST" in
    *[[:space:]]*|*'/'*|*'?'*|*'#'*) die "SERVER_HOST contains invalid characters: $SERVER_HOST" ;;
  esac
  case "$SERVER_HOST" in
    http://*|https://*|ws://*|wss://*) die 'SERVER_HOST must not include a scheme (hostname[:port] only)' ;;
  esac
  case "$SERVER_HOST" in
    *[!A-Za-z0-9.:\[\]-]*) die "SERVER_HOST contains invalid characters (hostname[:port] only): $SERVER_HOST" ;;
  esac
  local _nc="${SERVER_HOST//[^:]}"
  if [ ${#_nc} -gt 1 ] && [ "${SERVER_HOST::1}" != "[" ]; then
    die "SERVER_HOST has unbracketed multi-colon; use [bracketed] IPv6 form: $SERVER_HOST"
  fi
  case "$SERVER_HOST" in
    :*) die "SERVER_HOST has an empty host: $SERVER_HOST" ;;
  esac
  case "$SERVER_HOST" in
    *:) die "SERVER_HOST has an empty port: $SERVER_HOST" ;;
  esac
  local host="" port=""
  case "$SERVER_HOST" in
    \[*:*\]:*)
      # IPv6 literal with port, e.g. [::1]:8443
      host="${SERVER_HOST%%]:*}"
      host="${host#\[}"
      port="${SERVER_HOST##*]:}"
      ;;
    \[*:*\])
      # Bare IPv6 literal, e.g. [::1]
      host="$SERVER_HOST"
      ;;
    *:*)
      host="${SERVER_HOST%%:*}"
      port="${SERVER_HOST##*:}"
      ;;
    *)
      host="$SERVER_HOST"
      ;;
  esac
  [ -n "$host" ] || die "SERVER_HOST has an empty host: $SERVER_HOST"
  if [ -n "$port" ]; then
    [[ "$port" =~ ^[0-9]+$ ]] || die "SERVER_HOST has a malformed port: $SERVER_HOST"
    [ "$port" -ge 1 ] && [ "$port" -le 65535 ] || die "SERVER_HOST port must be in 1..65535: $SERVER_HOST"
  fi
}

validate_numeric() {
  local name="$1" value="$2" min="$3"
  [[ "$value" =~ ^[0-9]+$ ]] || die "$name must be an integer >= $min, got '$value'"
  [ "$value" -ge "$min" ] || die "$name must be >= $min, got '$value'"
}

validate_tuning() {
  validate_numeric 'INSTALL_RELEASES_KEEP' "$INSTALL_RELEASES_KEEP" 2
  validate_numeric 'SETUP_LOG_KEEP' "$SETUP_LOG_KEEP" 1
  validate_numeric 'TUNNEL_READY_TIMEOUT_SECS' "$TUNNEL_READY_TIMEOUT_SECS" 1
  validate_numeric 'TUNNEL_ROLLBACK_TIMEOUT_SECS' "$TUNNEL_ROLLBACK_TIMEOUT_SECS" 1
}

validate_install_uuid() {
  [ -n "$INSTALL_UUID" ] || die 'INSTALL_UUID is required and must be pinned on the server'
  case "$INSTALL_UUID" in
    *[!A-Za-z0-9._-]*) die "INSTALL_UUID contains invalid characters (allowed: [A-Za-z0-9._-]): $INSTALL_UUID" ;;
  esac
}

require_tools() {
  command -v node >/dev/null || die 'Node.js 20 or newer is required'
  command -v npm  >/dev/null || die 'npm is required'
  command -v curl >/dev/null || die 'curl is required'
  command -v ps   >/dev/null || die 'ps is required'
  local major
  major="$(node -p 'Number(process.versions.node.split(".")[0])')"
  [ "$major" -ge 20 ] || die "Node.js 20 or newer is required (found $(node -v))"
}

ensure_credentials() {
  TUNNEL_USERNAME="${TUNNEL_USERNAME:-}"
  TUNNEL_PASSWORD="${TUNNEL_PASSWORD:-}"
  if [ -z "$TUNNEL_USERNAME" ]; then
    [ -r /dev/tty ] || die 'TUNNEL_USERNAME is required in non-interactive mode'
    read -rp 'Tunnel username: ' TUNNEL_USERNAME </dev/tty
  fi
  if [ -z "$TUNNEL_PASSWORD" ]; then
    [ -r /dev/tty ] || die 'TUNNEL_PASSWORD is required in non-interactive mode'
    read -rsp 'Tunnel password: ' TUNNEL_PASSWORD </dev/tty
    printf '\n' >/dev/tty
  fi
  [ -n "$TUNNEL_USERNAME" ] || die 'Tunnel username cannot be empty'
  [ -n "$TUNNEL_PASSWORD" ] || die 'Tunnel password cannot be empty'
}

# ---------------------------------------------------------------------------
# Install lock (atomic directory with PID metadata)
# ---------------------------------------------------------------------------

acquire_lock() {
  LOCK_DIR="$WORK_DIR/.install.lock"
  local attempt owner=""
  for attempt in 1 2 3; do
    if mkdir "$LOCK_DIR" 2>/dev/null; then
      printf '%s\n' "$$" > "$LOCK_DIR/pid"
      trap cleanup_on_exit EXIT
      return 0
    fi
    if [ -f "$LOCK_DIR/pid" ]; then
      owner="$(cat "$LOCK_DIR/pid" 2>/dev/null || true)"
    fi
    if [[ "$owner" =~ ^[0-9]+$ ]] && ! kill -0 "$owner" 2>/dev/null; then
      warn "Removing stale install lock held by dead PID $owner"
      rm -rf "$LOCK_DIR"
      continue
    fi
    die "Another installation is already running (lock: $LOCK_DIR)"
  done
  die "Another installation is already running (lock: $LOCK_DIR)"
}

release_lock() {
  if [ -n "${LOCK_DIR:-}" ] && [ -d "$LOCK_DIR" ]; then
    local owner=""
    [ -f "$LOCK_DIR/pid" ] && owner="$(cat "$LOCK_DIR/pid" 2>/dev/null || true)"
    if [ "$owner" = "$$" ]; then
      rm -rf "$LOCK_DIR"
    fi
  fi
}

cleanup_on_exit() {
  # Never leave a failed candidate process running.
  if [ -n "${ACTIVE_PID:-}" ] && [[ "$ACTIVE_PID" =~ ^[0-9]+$ ]] && kill -0 "$ACTIVE_PID" 2>/dev/null; then
    kill "$ACTIVE_PID" 2>/dev/null || true
    kill -0 "$ACTIVE_PID" 2>/dev/null && kill -9 "$ACTIVE_PID" 2>/dev/null || true
  fi
  # Remove an orphaned (never activated) staging release.
  if [ "${NEW_RELEASE_READY:-false}" = false ] && [ "${KEEP_FAILED_RELEASE:-false}" = false ] \
     && [ -n "${RELEASE_DIR:-}" ] && [ -d "$RELEASE_DIR" ]; then
    rm -rf "$RELEASE_DIR" 2>/dev/null || true
  fi
  for ld in ${LINK_DIRS[@]+"${LINK_DIRS[@]}"}; do
    if [ -d "$ld" ]; then
      rmdir "$ld" 2>/dev/null || true
    fi
  done
  release_lock
}

# ---------------------------------------------------------------------------
# Signal-safe interrupt handling
# ---------------------------------------------------------------------------

rollback_after_interrupt() {
  if [ "${ROLLBACK_IN_PROGRESS:-0}" = 1 ]; then
    return 0
  fi
  ROLLBACK_IN_PROGRESS=1

  warn "Interrupted during phase=$INSTALL_PHASE; attempting rollback..."

  # P1-3: If we are in the stopping-old phase and the old process is still
  # alive, do NOT start a duplicate.  Just restore symlinks and exit.
  if [ "$INSTALL_PHASE" = "stopping-old" ] \
     && [ -n "${OLD_PID:-}" ] && [[ "$OLD_PID" =~ ^[0-9]+$ ]] \
     && kill -0 "$OLD_PID" 2>/dev/null; then
    if [ -n "${OLD_CURRENT:-}" ] && [ -d "${OLD_CURRENT:-}" ]; then
      activate_release "$OLD_CURRENT" "current" 2>/dev/null || true
    fi
    if [ -n "${PREVIOUS_BEFORE:-}" ] && [ -d "${PREVIOUS_BEFORE:-}" ]; then
      activate_release "$PREVIOUS_BEFORE" "previous" 2>/dev/null || true
    elif [ -n "${OLD_CURRENT:-}" ] && [ -d "${OLD_CURRENT:-}" ]; then
      activate_release "$OLD_CURRENT" "previous" 2>/dev/null || true
    else
      rm -f "$WORK_DIR/previous" 2>/dev/null || true
    fi
    cleanup_on_exit
    return 0
  fi

  # Kill candidate if running
  if [ -n "${ACTIVE_PID:-}" ] && [[ "$ACTIVE_PID" =~ ^[0-9]+$ ]] && kill -0 "$ACTIVE_PID" 2>/dev/null; then
    kill "$ACTIVE_PID" 2>/dev/null || true
    for ((i=0; i<10; i++)); do
      kill -0 "$ACTIVE_PID" 2>/dev/null || break
      sleep 0.1
    done
    kill -0 "$ACTIVE_PID" 2>/dev/null && kill -9 "$ACTIVE_PID" 2>/dev/null || true
  fi
  ACTIVE_PID=""
  preserve_failed_log 2>/dev/null || true

  # P1-1: Capture rollback target from immutable OLD_CURRENT BEFORE restoring
  # symlinks.  Never infer the restart target from the post-restoration
  # previous symlink.
  local rollback_release="${OLD_CURRENT:-}"

  # Restore symlinks
  if [ -n "$rollback_release" ] && [ -d "$rollback_release" ]; then
    activate_release "$rollback_release" "current" 2>/dev/null || true
  fi
  if [ -n "${PREVIOUS_BEFORE:-}" ] && [ -d "${PREVIOUS_BEFORE:-}" ]; then
    activate_release "$PREVIOUS_BEFORE" "previous" 2>/dev/null || true
  elif [ -n "$rollback_release" ] && [ -d "$rollback_release" ]; then
    activate_release "$rollback_release" "previous" 2>/dev/null || true
  else
    rm -f "$WORK_DIR/previous" 2>/dev/null || true
  fi

  # P1-1: Start the captured rollback release, not the post-restoration
  # previous symlink.
  if [ -n "$rollback_release" ] && [ -d "$rollback_release" ]; then
    local rollback_pid
    rollback_pid="$(start_process "$rollback_release" previous 2>/dev/null)" || true
    if [ -n "$rollback_pid" ]; then
      info "Waiting for rollback readiness after interrupt (PID: $rollback_pid)..."
      if wait_for_readiness "$rollback_pid" "$TUNNEL_ROLLBACK_TIMEOUT_SECS" 2>/dev/null; then
        info "Rollback after interrupt succeeded"
      else
        warn "Rollback after interrupt: previous process did not become ready"
        kill_candidate "$rollback_pid" 2>/dev/null || true
        cleanup_stale_metadata "$rollback_pid" 2>/dev/null || true
      fi
    fi
  fi

  cleanup_on_exit
}

handle_interrupt() {
  local sig="$1"

  if [ "${ROLLBACK_IN_PROGRESS:-0}" = 1 ]; then
    exit 130
  fi

  if [ "${TRANSACTION_DESTRUCTIVE:-0}" = 1 ]; then
    rollback_after_interrupt || true
  fi

  exit 130
}

# ---------------------------------------------------------------------------
# Artifact fetching
# ---------------------------------------------------------------------------

require_secure_url() {
  local url="$1" name="$2"
  case "$url" in
    https://*) : ;;
    http://*)
      if [ "${ALLOW_INSECURE_BUNDLE_URL:-0}" = 1 ]; then
        warn "$name uses an insecure http:// URL (ALLOW_INSECURE_BUNDLE_URL=1)"
      else
        die "$name must use https:// (set ALLOW_INSECURE_BUNDLE_URL=1 only for local development)"
      fi
      ;;
    *)
      die "$name must be an absolute https:// URL"
      ;;
  esac
}

download_atomic() {
  local url="$1" dest="$2"
  local tmp; tmp="$(mktemp "$dest.part.XXXXXX")"
  local rc=0
  curl -fsSL --connect-timeout 15 "$url" -o "$tmp" 2>/dev/null || rc=$?
  if [ "$rc" -ne 0 ]; then
    rm -f "$tmp"
    return 1
  fi
  mv -f "$tmp" "$dest"
}

# ---------------------------------------------------------------------------
# Release / symlink management
# ---------------------------------------------------------------------------

current_release_path() {
  if [ -L "$WORK_DIR/current" ]; then
    readlink "$WORK_DIR/current" 2>/dev/null || true
  fi
}

previous_release_path() {
  if [ -L "$WORK_DIR/previous" ]; then
    readlink "$WORK_DIR/previous" 2>/dev/null || true
  fi
}

activate_release() {
  local release_dir="$1" link_name="$2"
  local tmpdir; tmpdir="$(mktemp -d "$WORK_DIR/.link.XXXXXX")"
  LINK_DIRS+=("$tmpdir")
  ln -s "$release_dir" "$tmpdir/$link_name"
  if mv -Tf "$tmpdir/$link_name" "$WORK_DIR/$link_name" 2>/dev/null; then
    :
  else
    # Portable fallback for systems without GNU mv -T.
    local old_link="$WORK_DIR/.link.old.$$"
    rm -f "$old_link"
    mv -f "$WORK_DIR/$link_name" "$old_link" 2>/dev/null || true
    mv -f "$tmpdir/$link_name" "$WORK_DIR/$link_name"
    rm -f "$old_link"
  fi
  rm -f "$tmpdir/$link_name"
  rmdir "$tmpdir" 2>/dev/null || true
}

# ---------------------------------------------------------------------------
# Process lifecycle
# ---------------------------------------------------------------------------

is_expected_process() {
  local pid="$1" expected_js="$2"
  [[ "$pid" =~ ^[0-9]+$ ]] || return 1
  kill -0 "$pid" 2>/dev/null || return 1
  local args
  args="$(ps -p "$pid" -o args= 2>/dev/null || true)"
  if [ -n "$expected_js" ]; then
    case "$args" in *"$expected_js"*) return 0 ;; *) return 1 ;; esac
  else
    case "$args" in *"$ROLE_JS"*) return 0 ;; *) return 1 ;; esac
  fi
}

# Read the PID file, validate the process is alive, and verify it is the
# managed process we expect.  Returns the verified PID on stdout, or
# returns nothing if there is no valid managed process to operate on.
resolve_running_managed_pid() {
  local pid=""
  [ -f "$WORK_DIR/$ROLE.pid" ] && pid="$(cat "$WORK_DIR/$ROLE.pid" 2>/dev/null || true)"
  if ! [[ "$pid" =~ ^[0-9]+$ ]]; then
    return 0
  fi
  if ! kill -0 "$pid" 2>/dev/null; then
    info "Removing stale $ROLE.pid for dead PID $pid"
    rm -f "$WORK_DIR/$ROLE.pid"
    return 0
  fi
  local expected_js=""
  local cur; cur="$(current_release_path)"
  if [ -n "$cur" ] && [ -d "$cur" ]; then
    expected_js="$cur/$ROLE_JS"
  fi
  if ! is_expected_process "$pid" "$expected_js"; then
    die "PID $pid (from $WORK_DIR/$ROLE.pid) does not match the expected bundle ($expected_js or legacy $ROLE_JS); refusing to operate"
  fi
  printf '%s' "$pid"
}

stop_old_process() {
  local pid="${1:-}"
  if [ -n "$pid" ]; then
    info "Stopping existing $ROLE (PID: $pid)"
    kill "$pid" 2>/dev/null || true
    for ((i=0; i<20; i++)); do
      kill -0 "$pid" 2>/dev/null || break
      sleep 0.1
    done
    kill -0 "$pid" 2>/dev/null && kill -9 "$pid" 2>/dev/null || true
  fi
  rm -f "$WORK_DIR/$ROLE.pid"
  rm -f "$WORK_DIR/$ROLE.ready"
}

cleanup_stale_metadata() {
  local dead_pid="$1"
  [[ "$dead_pid" =~ ^[0-9]+$ ]] || return 0
  if [ -f "$WORK_DIR/$ROLE.pid" ]; then
    local stored; stored="$(cat "$WORK_DIR/$ROLE.pid" 2>/dev/null || true)"
    if [ "$stored" = "$dead_pid" ]; then
      rm -f "$WORK_DIR/$ROLE.pid"
    fi
  fi
  if [ -f "$WORK_DIR/$ROLE.ready" ]; then
    local stored; stored="$(cat "$WORK_DIR/$ROLE.ready" 2>/dev/null || true)"
    if [ "$stored" = "$dead_pid" ]; then
      rm -f "$WORK_DIR/$ROLE.ready"
    fi
  fi
}

# Reset all OLD_* and OLD_*_SET variables from a previous capture attempt.
reset_previous_config_state() {
  unset OLD_TUNNEL_SERVER_URL OLD_TUNNEL_SERVER_URL_SET
  unset OLD_TUNNEL_USERNAME OLD_TUNNEL_USERNAME_SET
  unset OLD_TUNNEL_PASSWORD OLD_TUNNEL_PASSWORD_SET
  unset OLD_TCP_TUNNEL_HOST OLD_TCP_TUNNEL_HOST_SET
  unset OLD_TCP_CLIENT_ALLOWED_HOSTS OLD_TCP_CLIENT_ALLOWED_HOSTS_SET
  unset OLD_TCP_CONNECT_TIMEOUT_MS OLD_TCP_CONNECT_TIMEOUT_MS_SET
  unset OLD_TARGET_ORIGIN OLD_TARGET_ORIGIN_SET
  unset OLD_MAX_CONCURRENT_STREAMS OLD_MAX_CONCURRENT_STREAMS_SET
  unset OLD_STREAM_IDLE_TIMEOUT_MS OLD_STREAM_IDLE_TIMEOUT_MS_SET
  unset OLD_DRAIN_TIMEOUT_MS OLD_DRAIN_TIMEOUT_MS_SET
  unset OLD_WS_HIGH_WATER_BYTES OLD_WS_HIGH_WATER_BYTES_SET
  unset OLD_MAX_FRAME_PAYLOAD_BYTES OLD_MAX_FRAME_PAYLOAD_BYTES_SET
  unset OLD_LOCAL_REQUEST_TIMEOUT_MS OLD_LOCAL_REQUEST_TIMEOUT_MS_SET
  unset OLD_VERBOSE OLD_VERBOSE_SET
  unset OLD_LOG_FORMAT OLD_LOG_FORMAT_SET
  unset PREVIOUS_CONFIG_CAPTURED
  unset ROLLBACK_CONFIG_MODE
}

# Capture the previous runtime config atomically. Parses into local
# CAPTURED_* variables first, validates required keys, and only commits
# to OLD_* after full validation success. On failure no OLD_* state is
# modified, preventing hybrid partial-capture rollback.
capture_previous_config() {
  local pid="${1:-}"
  if [ -z "$pid" ]; then
    return 0
  fi
  local source="${PREVIOUS_ENVIRON_SOURCE:-/proc/$pid/environ}"
  if [ ! -r "$source" ]; then
    error "Cannot read previous runtime environment from $source"
    return 1
  fi
  local c_url="" c_username="" c_password="" c_tcp_host=""
  local c_allowed_hosts="" c_connect_timeout="" c_target_origin=""
  local c_max_streams="" c_idle_timeout="" c_drain_timeout=""
  local c_ws_high="" c_max_frame="" c_local_timeout=""
  local c_verbose="" c_log_format=""
  local f_url=0 f_username=0 f_password=0 f_tcp_host=0
  local f_allowed_hosts=0 f_connect_timeout=0 f_target_origin=0
  local f_max_streams=0 f_idle_timeout=0 f_drain_timeout=0
  local f_ws_high=0 f_max_frame=0 f_local_timeout=0
  local f_verbose=0 f_log_format=0
  local entry
  while IFS= read -r -d '' entry; do
    case "$entry" in
      TUNNEL_SERVER_URL=*)           c_url="${entry#TUNNEL_SERVER_URL=}"; f_url=1 ;;
      TUNNEL_USERNAME=*)             c_username="${entry#TUNNEL_USERNAME=}"; f_username=1 ;;
      TUNNEL_PASSWORD=*)             c_password="${entry#TUNNEL_PASSWORD=}"; f_password=1 ;;
      TCP_TUNNEL_HOST=*)             c_tcp_host="${entry#TCP_TUNNEL_HOST=}"; f_tcp_host=1 ;;
      TCP_CLIENT_ALLOWED_HOSTS=*)    c_allowed_hosts="${entry#TCP_CLIENT_ALLOWED_HOSTS=}"; f_allowed_hosts=1 ;;
      TCP_CONNECT_TIMEOUT_MS=*)      c_connect_timeout="${entry#TCP_CONNECT_TIMEOUT_MS=}"; f_connect_timeout=1 ;;
      TARGET_ORIGIN=*)               c_target_origin="${entry#TARGET_ORIGIN=}"; f_target_origin=1 ;;
      MAX_CONCURRENT_STREAMS=*)      c_max_streams="${entry#MAX_CONCURRENT_STREAMS=}"; f_max_streams=1 ;;
      STREAM_IDLE_TIMEOUT_MS=*)      c_idle_timeout="${entry#STREAM_IDLE_TIMEOUT_MS=}"; f_idle_timeout=1 ;;
      DRAIN_TIMEOUT_MS=*)            c_drain_timeout="${entry#DRAIN_TIMEOUT_MS=}"; f_drain_timeout=1 ;;
      WS_HIGH_WATER_BYTES=*)         c_ws_high="${entry#WS_HIGH_WATER_BYTES=}"; f_ws_high=1 ;;
      MAX_FRAME_PAYLOAD_BYTES=*)     c_max_frame="${entry#MAX_FRAME_PAYLOAD_BYTES=}"; f_max_frame=1 ;;
      LOCAL_REQUEST_TIMEOUT_MS=*)    c_local_timeout="${entry#LOCAL_REQUEST_TIMEOUT_MS=}"; f_local_timeout=1 ;;
      VERBOSE=*)                     c_verbose="${entry#VERBOSE=}"; f_verbose=1 ;;
      LOG_FORMAT=*)                  c_log_format="${entry#LOG_FORMAT=}"; f_log_format=1 ;;
    esac
  done < "$source"
  local missing=""
  if [ "$f_url" = 0 ] || [ -z "$c_url" ]; then missing="$missing TUNNEL_SERVER_URL"; fi
  if [ "$f_username" = 0 ] || [ -z "$c_username" ]; then missing="$missing TUNNEL_USERNAME"; fi
  if [ "$f_password" = 0 ] || [ -z "$c_password" ]; then missing="$missing TUNNEL_PASSWORD"; fi
  if [ "$f_tcp_host" = 0 ] || [ -z "$c_tcp_host" ]; then missing="$missing TCP_TUNNEL_HOST"; fi
  if [ -n "$missing" ]; then
    error "Previous environment missing required keys:${missing}"
    return 1
  fi
  reset_previous_config_state
  OLD_TUNNEL_SERVER_URL="$c_url"; OLD_TUNNEL_SERVER_URL_SET=1
  OLD_TUNNEL_USERNAME="$c_username"; OLD_TUNNEL_USERNAME_SET=1
  OLD_TUNNEL_PASSWORD="$c_password"; OLD_TUNNEL_PASSWORD_SET=1
  OLD_TCP_TUNNEL_HOST="$c_tcp_host"; OLD_TCP_TUNNEL_HOST_SET=1
  if [ "$f_allowed_hosts" = 1 ]; then OLD_TCP_CLIENT_ALLOWED_HOSTS="$c_allowed_hosts"; OLD_TCP_CLIENT_ALLOWED_HOSTS_SET=1; fi
  if [ "$f_connect_timeout" = 1 ]; then OLD_TCP_CONNECT_TIMEOUT_MS="$c_connect_timeout"; OLD_TCP_CONNECT_TIMEOUT_MS_SET=1; fi
  if [ "$f_target_origin" = 1 ]; then OLD_TARGET_ORIGIN="$c_target_origin"; OLD_TARGET_ORIGIN_SET=1; fi
  if [ "$f_max_streams" = 1 ]; then OLD_MAX_CONCURRENT_STREAMS="$c_max_streams"; OLD_MAX_CONCURRENT_STREAMS_SET=1; fi
  if [ "$f_idle_timeout" = 1 ]; then OLD_STREAM_IDLE_TIMEOUT_MS="$c_idle_timeout"; OLD_STREAM_IDLE_TIMEOUT_MS_SET=1; fi
  if [ "$f_drain_timeout" = 1 ]; then OLD_DRAIN_TIMEOUT_MS="$c_drain_timeout"; OLD_DRAIN_TIMEOUT_MS_SET=1; fi
  if [ "$f_ws_high" = 1 ]; then OLD_WS_HIGH_WATER_BYTES="$c_ws_high"; OLD_WS_HIGH_WATER_BYTES_SET=1; fi
  if [ "$f_max_frame" = 1 ]; then OLD_MAX_FRAME_PAYLOAD_BYTES="$c_max_frame"; OLD_MAX_FRAME_PAYLOAD_BYTES_SET=1; fi
  if [ "$f_local_timeout" = 1 ]; then OLD_LOCAL_REQUEST_TIMEOUT_MS="$c_local_timeout"; OLD_LOCAL_REQUEST_TIMEOUT_MS_SET=1; fi
  if [ "$f_verbose" = 1 ]; then OLD_VERBOSE="$c_verbose"; OLD_VERBOSE_SET=1; fi
  if [ "$f_log_format" = 1 ]; then OLD_LOG_FORMAT="$c_log_format"; OLD_LOG_FORMAT_SET=1; fi
  PREVIOUS_CONFIG_CAPTURED=1
  ROLLBACK_CONFIG_MODE=previous
  return 0
}

kill_candidate() {
  local pid="$1"
  if [[ "$pid" =~ ^[0-9]+$ ]] && kill -0 "$pid" 2>/dev/null; then
    kill "$pid" 2>/dev/null || true
    for ((i=0; i<20; i++)); do
      kill -0 "$pid" 2>/dev/null || break
      sleep 0.1
    done
    kill -0 "$pid" 2>/dev/null && kill -9 "$pid" 2>/dev/null || true
  fi
}

rotate_log() {
  if [ -f "$WORK_DIR/$ROLE.log" ]; then
    mkdir -p "$WORK_DIR/logs"
    local ts; ts="$(date -u +%Y%m%dT%H%M%SZ)"
    mv -f "$WORK_DIR/$ROLE.log" "$WORK_DIR/logs/$ROLE.$ts.$$.log"
  fi
}

preserve_failed_log() {
  if [ -f "$WORK_DIR/$ROLE.log" ]; then
    mkdir -p "$WORK_DIR/logs"
    cp -f "$WORK_DIR/$ROLE.log" "$WORK_DIR/logs/$ROLE.failed.$(basename "$RELEASE_DIR").log" 2>/dev/null || true
  fi
}

start_process() {
  local release_dir="$1"
  local config_source="${2:-current}"
  rotate_log
  local log_file="$WORK_DIR/$ROLE.log"
  rm -f "$WORK_DIR/$ROLE.ready"

  local env_args=()
  local effective_source="$config_source"
  if [ "$config_source" = "previous" ]; then
    case "${ROLLBACK_CONFIG_MODE:-current}" in
      previous) effective_source="previous" ;;
      current)  effective_source="current" ;;
      *)        die "invalid rollback mode: $ROLLBACK_CONFIG_MODE" ;;
    esac
  fi
  if [ "$effective_source" = "previous" ]; then
    env_args+=("TUNNEL_SERVER_URL=$OLD_TUNNEL_SERVER_URL")
    env_args+=("TUNNEL_USERNAME=$OLD_TUNNEL_USERNAME")
    env_args+=("TUNNEL_PASSWORD=$OLD_TUNNEL_PASSWORD")
    env_args+=("TCP_TUNNEL_HOST=$OLD_TCP_TUNNEL_HOST")
    if [ "${OLD_TCP_CLIENT_ALLOWED_HOSTS_SET:-0}" = 1 ]; then
      env_args+=("TCP_CLIENT_ALLOWED_HOSTS=$OLD_TCP_CLIENT_ALLOWED_HOSTS")
    fi
    if [ "${OLD_TCP_CONNECT_TIMEOUT_MS_SET:-0}" = 1 ]; then
      env_args+=("TCP_CONNECT_TIMEOUT_MS=$OLD_TCP_CONNECT_TIMEOUT_MS")
    fi
    if [ "${OLD_TARGET_ORIGIN_SET:-0}" = 1 ]; then
      env_args+=("TARGET_ORIGIN=$OLD_TARGET_ORIGIN")
    fi
    if [ "${OLD_MAX_CONCURRENT_STREAMS_SET:-0}" = 1 ]; then
      env_args+=("MAX_CONCURRENT_STREAMS=$OLD_MAX_CONCURRENT_STREAMS")
    fi
    if [ "${OLD_STREAM_IDLE_TIMEOUT_MS_SET:-0}" = 1 ]; then
      env_args+=("STREAM_IDLE_TIMEOUT_MS=$OLD_STREAM_IDLE_TIMEOUT_MS")
    fi
    if [ "${OLD_DRAIN_TIMEOUT_MS_SET:-0}" = 1 ]; then
      env_args+=("DRAIN_TIMEOUT_MS=$OLD_DRAIN_TIMEOUT_MS")
    fi
    if [ "${OLD_WS_HIGH_WATER_BYTES_SET:-0}" = 1 ]; then
      env_args+=("WS_HIGH_WATER_BYTES=$OLD_WS_HIGH_WATER_BYTES")
    fi
    if [ "${OLD_MAX_FRAME_PAYLOAD_BYTES_SET:-0}" = 1 ]; then
      env_args+=("MAX_FRAME_PAYLOAD_BYTES=$OLD_MAX_FRAME_PAYLOAD_BYTES")
    fi
    if [ "${OLD_LOCAL_REQUEST_TIMEOUT_MS_SET:-0}" = 1 ]; then
      env_args+=("LOCAL_REQUEST_TIMEOUT_MS=$OLD_LOCAL_REQUEST_TIMEOUT_MS")
    fi
    if [ "${OLD_VERBOSE_SET:-0}" = 1 ]; then
      env_args+=("VERBOSE=$OLD_VERBOSE")
    fi
    if [ "${OLD_LOG_FORMAT_SET:-0}" = 1 ]; then
      env_args+=("LOG_FORMAT=$OLD_LOG_FORMAT")
    fi
  else
    env_args+=("TUNNEL_SERVER_URL=wss://$SERVER_HOST/tunnel")
    env_args+=("TUNNEL_USERNAME=$TUNNEL_USERNAME")
    env_args+=("TUNNEL_PASSWORD=$TUNNEL_PASSWORD")
    env_args+=("TCP_TUNNEL_HOST=$SERVICE_HOST")
    env_args+=("TCP_CLIENT_ALLOWED_HOSTS=${TCP_CLIENT_ALLOWED_HOSTS:-$SERVICE_HOST}")
    env_args+=("TCP_CONNECT_TIMEOUT_MS=${TCP_CONNECT_TIMEOUT_MS:-10000}")
    env_args+=("TARGET_ORIGIN=${TARGET_ORIGIN:-http://127.0.0.1:8000}")
    env_args+=("MAX_CONCURRENT_STREAMS=${MAX_CONCURRENT_STREAMS:-200}")
    env_args+=("STREAM_IDLE_TIMEOUT_MS=${STREAM_IDLE_TIMEOUT_MS:-120000}")
    env_args+=("DRAIN_TIMEOUT_MS=${DRAIN_TIMEOUT_MS:-30000}")
    env_args+=("WS_HIGH_WATER_BYTES=${WS_HIGH_WATER_BYTES:-1048576}")
    env_args+=("MAX_FRAME_PAYLOAD_BYTES=${MAX_FRAME_PAYLOAD_BYTES:-262144}")
    env_args+=("LOCAL_REQUEST_TIMEOUT_MS=${LOCAL_REQUEST_TIMEOUT_MS:-0}")
    env_args+=("VERBOSE=${VERBOSE:-false}")
    env_args+=("LOG_FORMAT=${LOG_FORMAT:-text}")
  fi
  env_args+=("TUNNEL_READY_FILE=$WORK_DIR/$ROLE.ready")

  env -i "${env_args[@]}" PATH="$PATH" HOME="${HOME:-/root}" nohup node "$release_dir/$ROLE_JS" >"$log_file" 2>&1 &
  local pid=$!
  printf '%s\n' "$pid" > "$WORK_DIR/$ROLE.pid"
  chmod 600 "$WORK_DIR/$ROLE.pid" 2>/dev/null || true
  [ -f "$log_file" ] && chmod 600 "$log_file" 2>/dev/null || true
  echo "$pid"
}

wait_for_readiness() {
  local expected_pid="$1" timeout_seconds="$2"
  local ready_file="$WORK_DIR/$ROLE.ready"
  local log_file="$WORK_DIR/$ROLE.log"
  local steps=$((timeout_seconds * 2))
  local i rp
  for ((i=0; i<steps; i++)); do
    if [ -f "$ready_file" ]; then
      rp="$(cat "$ready_file" 2>/dev/null || true)"
      rp="${rp%"${rp##*[![:space:]]}"}"
      if [ "$rp" = "$expected_pid" ] && kill -0 "$expected_pid" 2>/dev/null; then
        return 0
      fi
    fi
    if grep -Eq 'auth_failed' "$log_file" 2>/dev/null; then
      return 2
    fi
    if ! kill -0 "$expected_pid" 2>/dev/null; then
      return 1
    fi
    sleep 0.5
  done
  return 1
}

cleanup_failed_activation() {
  local failed_release="$1"
  if [ -L "$WORK_DIR/current" ]; then
    local cur; cur="$(readlink "$WORK_DIR/current" 2>/dev/null || true)"
    if [ "$cur" = "$failed_release" ]; then
      rm -f "$WORK_DIR/current"
    fi
  fi
  rm -f "$WORK_DIR/$ROLE.pid" "$WORK_DIR/$ROLE.ready"
}

rollback_to_previous() {
  local failed_release="$1"
  local prev=""
  if [ -L "$WORK_DIR/previous" ]; then
    prev="$(readlink "$WORK_DIR/previous" 2>/dev/null || true)"
    if [ -z "$prev" ] || [ ! -d "$prev" ]; then
      prev=""
    fi
  fi
  if [ -z "$prev" ]; then
    cleanup_failed_activation "$failed_release"
    rm -rf "$failed_release"
    error "No previous release to roll back to"
    return 1
  fi

  warn "Restoring previous release: $prev"
  activate_release "$prev" "current"
  if [ -n "$PREVIOUS_BEFORE" ] && [ -d "$PREVIOUS_BEFORE" ]; then
    activate_release "$PREVIOUS_BEFORE" "previous"
  elif [ -n "$OLD_CURRENT" ] && [ -d "$OLD_CURRENT" ]; then
    activate_release "$OLD_CURRENT" "previous"
  else
    rm -f "$WORK_DIR/previous"
  fi

  local rollback_pid
  rollback_pid="$(start_process "$prev" previous)"
  info "Waiting for rollback readiness (PID: $rollback_pid)..."
  if wait_for_readiness "$rollback_pid" "$TUNNEL_ROLLBACK_TIMEOUT_SECS"; then
    rm -rf "$failed_release"
    info "Rollback complete: restored $prev"
    return 0
  fi
  error "Rollback failed: previous release did not become ready"
  kill_candidate "$rollback_pid"
  cleanup_stale_metadata "$rollback_pid"
  return 2
}

# ---------------------------------------------------------------------------
# Staging
# ---------------------------------------------------------------------------

stage_release() {
  local base="https://$SERVER_HOST"
  local bundle_url="${CLIENT_BUNDLE_URL:-$base/$INSTALL_UUID-client.js}"
  local manifest_url="${CLIENT_MANIFEST_URL:-$base/$INSTALL_UUID-client-package.json}"

  if [ -n "${CLIENT_BUNDLE_PATH:-}" ]; then
    [ -r "$CLIENT_BUNDLE_PATH" ] || die "CLIENT_BUNDLE_PATH is not readable: $CLIENT_BUNDLE_PATH"
    cp "$CLIENT_BUNDLE_PATH" "$RELEASE_DIR/$ROLE_JS"
  else
    require_secure_url "$bundle_url" "CLIENT_BUNDLE_URL"
    info "Fetching client bundle..."
    download_atomic "$bundle_url" "$RELEASE_DIR/$ROLE_JS" || die "Failed to download $bundle_url"
  fi

  info "Validating bundle..."
  node --check "$RELEASE_DIR/$ROLE_JS"
  info "Bundle OK"

  require_secure_url "$manifest_url" "CLIENT_MANIFEST_URL"
  info "Fetching client package manifest..."
  if ! download_atomic "$manifest_url" "$RELEASE_DIR/package.json"; then
    if [ "${ALLOW_FALLBACK_MANIFEST:-0}" = 1 ]; then
      printf '{"type":"module","private":true,"dependencies":{"ws":"^8.21.3"}}\n' > "$RELEASE_DIR/package.json"
      warn 'Server manifest unavailable; wrote the compatible fallback manifest (ALLOW_FALLBACK_MANIFEST=1)'
    else
      die "Failed to download manifest $manifest_url (set ALLOW_FALLBACK_MANIFEST=1 to fall back)"
    fi
  fi

  info "Installing dependencies..."
  ( cd "$RELEASE_DIR" && npm install --omit=dev ) || die 'Failed to install client dependencies'
  [ -d "$RELEASE_DIR/node_modules" ] || die 'Dependencies were not installed (node_modules missing)'
  info "Dependencies installed"
}

# ---------------------------------------------------------------------------
# Legacy layout migration (refactor2 pre-transactional installs)
# ---------------------------------------------------------------------------

migrate_legacy_layout() {
  if [ -L "$WORK_DIR/current" ]; then
    return 0
  fi
  [ -f "$WORK_DIR/$ROLE_JS" ] || return 0
  if ! node --check "$WORK_DIR/$ROLE_JS" >/dev/null 2>&1; then
    warn "Legacy bundle is invalid; keeping it in place (staged install will not touch it)"
    return 0
  fi
  local legacy_dir="$WORK_DIR/releases/release.legacy.$(date -u +%Y%m%dT%H%M%SZ).$$"
  mkdir -p "$legacy_dir"
  mv -f "$WORK_DIR/$ROLE_JS" "$legacy_dir/$ROLE_JS"
  if [ -f "$WORK_DIR/package.json" ]; then
    mv -f "$WORK_DIR/package.json" "$legacy_dir/package.json"
  fi
  if [ -d "$WORK_DIR/node_modules" ] && [ ! -d "$legacy_dir/node_modules" ] && [ ! -L "$legacy_dir/node_modules" ]; then
    mv -f "$WORK_DIR/node_modules" "$legacy_dir/node_modules" 2>/dev/null \
      || ln -s "$WORK_DIR/node_modules" "$legacy_dir/node_modules" 2>/dev/null \
      || true
  fi
  if [ -L "$WORK_DIR/previous" ]; then
    rm -f "$WORK_DIR/previous"
  fi
  activate_release "$legacy_dir" "previous"
  info "Preserved legacy bundle as previous release: $legacy_dir"
}

# ---------------------------------------------------------------------------
# Retention
# ---------------------------------------------------------------------------

prune_logs() {
  local count=0
  while IFS= read -r -d '' f; do
    count=$((count + 1))
    if [ "$count" -gt "$SETUP_LOG_KEEP" ]; then
      rm -f -- "$f"
    fi
  done < <(find "$WORK_DIR/logs" -maxdepth 1 -type f -name "$ROLE.*.log" \
           -printf '%T@\t%p\0' 2>/dev/null | sort -zrn -t $'\t' -k1,1 | cut -z -d $'\t' -f2-)
}

prune_releases() {
  local cur prev count=0
  cur="$(current_release_path)"
  prev="$(previous_release_path)"
  while IFS= read -r -d '' d; do
    [ -d "$d" ] || continue
    [ "$d" = "$cur" ] && continue
    [ "$d" = "$prev" ] && continue
    count=$((count + 1))
    if [ "$count" -gt $((INSTALL_RELEASES_KEEP - 2)) ]; then
      rm -rf -- "$d"
    fi
  done < <(find "$WORK_DIR/releases" -maxdepth 1 -type d -name 'release.*' \
           -printf '%T@\t%p\0' 2>/dev/null | sort -zrn -t $'\t' -k1,1 | cut -z -d $'\t' -f2-)
}

# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------

validate_server_host
validate_install_uuid
validate_tuning
require_tools
ensure_credentials

mkdir -p "$WORK_DIR"
chmod 700 "$WORK_DIR"
mkdir -p "$WORK_DIR/releases" "$WORK_DIR/logs"

acquire_lock

trap 'handle_interrupt INT' INT
trap 'handle_interrupt TERM' TERM
trap 'handle_interrupt HUP' HUP

NEW_RELEASE_READY=false
KEEP_FAILED_RELEASE=false
ACTIVE_PID=""
PREVIOUS_BEFORE=""
LINK_DIRS=()
INSTALL_PHASE="initial"
TRANSACTION_DESTRUCTIVE=0
ROLLBACK_IN_PROGRESS=0

RELEASE_DIR="$(mktemp -d "$WORK_DIR/releases/release.XXXXXXXX")"
info "Staging new release: $(basename "$RELEASE_DIR")"
INSTALL_PHASE="staging"
stage_release

migrate_legacy_layout

PREVIOUS_BEFORE="$(previous_release_path)"
OLD_CURRENT="$(current_release_path)"

OLD_PID="$(resolve_running_managed_pid || true)"

ROLLBACK_CONFIG_MODE=current
reset_previous_config_state
if ! capture_previous_config "$OLD_PID"; then
  reset_previous_config_state
  PREVIOUS_CONFIG_CAPTURED=0
  ROLLBACK_CONFIG_MODE=current
  if [ "${ALLOW_CODE_ONLY_ROLLBACK:-0}" = 1 ]; then
    warn 'Could not capture previous runtime config; continuing with code-only rollback (ALLOW_CODE_ONLY_ROLLBACK=1)'
  else
    die 'Cannot capture the previous runtime config; refusing to stop the running client (set ALLOW_CODE_ONLY_ROLLBACK=1 to allow code-only rollback)'
  fi
fi

INSTALL_PHASE="stopping-old"
TRANSACTION_DESTRUCTIVE=1
stop_old_process "$OLD_PID"
INSTALL_PHASE="old-stopped"

if [ -n "$OLD_CURRENT" ] && [ -d "$OLD_CURRENT" ]; then
  activate_release "$OLD_CURRENT" "previous"
  info "Saved previous release"
fi

INSTALL_PHASE="candidate-activated"
activate_release "$RELEASE_DIR" "current"
info "New release activated"

INSTALL_PHASE="candidate-running"
CLIENT_PID="$(start_process "$RELEASE_DIR" current)"
ACTIVE_PID="$CLIENT_PID"
info "Waiting for client readiness (PID: $CLIENT_PID)..."

rc=0
wait_for_readiness "$CLIENT_PID" "$TUNNEL_READY_TIMEOUT_SECS" || rc=$?

if [ "$rc" -eq 0 ]; then
  # P1-4: Commit the transaction immediately.  Once the candidate is accepted,
  # signal handling must not roll it back.
  NEW_RELEASE_READY=true
  INSTALL_PHASE="complete"
  TRANSACTION_DESTRUCTIVE=0
  ACTIVE_PID=""
  trap - INT TERM HUP
  prune_logs
  prune_releases
  info "Connected. Application hosts may now start their TCP agents."
  info "Log: $WORK_DIR/$ROLE.log"
  info "Release: $RELEASE_DIR"
  if [ -n "$OLD_CURRENT" ]; then
    info "Previous: $OLD_CURRENT"
  fi
  exit 0
fi

ACTIVE_PID=""
if [ "$rc" -eq 2 ]; then
  error 'Tunnel credentials were rejected (auth_failed)'
else
  error "Client did not become ready within ${TUNNEL_READY_TIMEOUT_SECS}s"
fi
[ -f "$WORK_DIR/$ROLE.log" ] && cat "$WORK_DIR/$ROLE.log" >&2 || true
kill_candidate "$CLIENT_PID"
preserve_failed_log

INSTALL_PHASE="rollback"
ROLLBACK_IN_PROGRESS=1
if rollback_to_previous "$RELEASE_DIR"; then
  die "Installation failed; rolled back to the previous release"
fi

KEEP_FAILED_RELEASE=true
die "Installation failed and rollback could not restore a working $ROLE"
