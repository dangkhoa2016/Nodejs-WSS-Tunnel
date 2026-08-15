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
#   CLIENT_BUNDLE_REFRESH         force a fresh manifest/bundle fetch
#   ALLOW_INSECURE_BUNDLE_URL=1   allow http:// artifact URLs (local dev only)
#   ALLOW_FALLBACK_MANIFEST=1     write a fallback manifest if fetch fails
#   INSTALL_RELEASES_KEEP         releases to keep after success (default 3)
#   SETUP_LOG_KEEP                rotated log files to keep (default 5)
#   TUNNEL_READY_TIMEOUT_SECS     readiness timeout (default 20)
#   TUNNEL_ROLLBACK_TIMEOUT_SECS  rollback readiness timeout (default 15)
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
  local port=""
  case "$SERVER_HOST" in
    \[*\]:*) port="${SERVER_HOST##*]:}" ;;
    *:*)     port="${SERVER_HOST##*:}" ;;
  esac
  if [ -n "$port" ]; then
    [[ "$port" =~ ^[0-9]+$ ]] || die "SERVER_HOST has a malformed port: $SERVER_HOST"
    [ "$port" -ge 1 ] && [ "$port" -le 65535 ] || die "SERVER_HOST port must be in 1..65535: $SERVER_HOST"
  fi
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

stop_old_process() {
  local expected_js=""
  local cur; cur="$(current_release_path)"
  if [ -n "$cur" ] && [ -d "$cur" ]; then
    expected_js="$cur/$ROLE_JS"
  fi
  if [ -f "$WORK_DIR/$ROLE.pid" ]; then
    local pid; pid="$(cat "$WORK_DIR/$ROLE.pid" 2>/dev/null || true)"
    if [[ "$pid" =~ ^[0-9]+$ ]] && kill -0 "$pid" 2>/dev/null; then
      if is_expected_process "$pid" "$expected_js"; then
        info "Stopping existing $ROLE (PID: $pid)"
        kill "$pid" 2>/dev/null || true
        for ((i=0; i<20; i++)); do
          kill -0 "$pid" 2>/dev/null || break
          sleep 0.1
        done
        kill -0 "$pid" 2>/dev/null && kill -9 "$pid" 2>/dev/null || true
      else
        die "PID $pid (from $WORK_DIR/$ROLE.pid) does not match the expected bundle ($expected_js or legacy $ROLE_JS); refusing to kill"
      fi
    elif [[ "$pid" =~ ^[0-9]+$ ]] && ! kill -0 "$pid" 2>/dev/null; then
      info "Removing stale $ROLE.pid for dead PID $pid"
    fi
    rm -f "$WORK_DIR/$ROLE.pid"
  fi
  rm -f "$WORK_DIR/$ROLE.ready"
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
  rotate_log
  local log_file="$WORK_DIR/$ROLE.log"
  rm -f "$WORK_DIR/$ROLE.ready"
  TUNNEL_SERVER_URL="wss://$SERVER_HOST/tunnel" \
  TUNNEL_USERNAME="$TUNNEL_USERNAME" \
  TUNNEL_PASSWORD="$TUNNEL_PASSWORD" \
  TCP_TUNNEL_HOST="$SERVICE_HOST" \
  TCP_CLIENT_ALLOWED_HOSTS="${TCP_CLIENT_ALLOWED_HOSTS:-$SERVICE_HOST}" \
  TCP_CONNECT_TIMEOUT_MS="${TCP_CONNECT_TIMEOUT_MS:-10000}" \
  TUNNEL_READY_FILE="$WORK_DIR/$ROLE.ready" \
  VERBOSE="${VERBOSE:-false}" \
  LOG_FORMAT="${LOG_FORMAT:-text}" \
    nohup node "$release_dir/$ROLE_JS" >"$log_file" 2>&1 &
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
  else
    rm -f "$WORK_DIR/previous"
  fi

  local rollback_pid
  rollback_pid="$(start_process "$prev")"
  info "Waiting for rollback readiness (PID: $rollback_pid)..."
  if wait_for_readiness "$rollback_pid" "$TUNNEL_ROLLBACK_TIMEOUT_SECS"; then
    rm -rf "$failed_release"
    info "Rollback complete: restored $prev"
    return 0
  fi
  error "Rollback failed: previous release did not become ready"
  kill_candidate "$rollback_pid"
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
  local count=0 f
  for f in $(ls -1dt "$WORK_DIR"/logs/$ROLE.*.log 2>/dev/null || true); do
    count=$((count + 1))
    if [ "$count" -gt "$SETUP_LOG_KEEP" ]; then
      rm -f "$f"
    fi
  done
}

prune_releases() {
  local cur prev count=0 d
  cur="$(current_release_path)"
  prev="$(previous_release_path)"
  for d in $(ls -1dt "$WORK_DIR"/releases/release.* 2>/dev/null || true); do
    [ -d "$d" ] || continue
    [ "$d" = "$cur" ] && continue
    [ "$d" = "$prev" ] && continue
    count=$((count + 1))
    if [ "$count" -gt $((INSTALL_RELEASES_KEEP - 2)) ]; then
      rm -rf "$d"
    fi
  done
}

# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------

validate_server_host
validate_install_uuid
require_tools
ensure_credentials

mkdir -p "$WORK_DIR"
chmod 700 "$WORK_DIR"
mkdir -p "$WORK_DIR/releases" "$WORK_DIR/logs"

acquire_lock

NEW_RELEASE_READY=false
KEEP_FAILED_RELEASE=false
ACTIVE_PID=""
PREVIOUS_BEFORE=""
LINK_DIRS=()

RELEASE_DIR="$(mktemp -d "$WORK_DIR/releases/release.XXXXXXXX")"
info "Staging new release: $(basename "$RELEASE_DIR")"
stage_release

migrate_legacy_layout

PREVIOUS_BEFORE="$(previous_release_path)"
OLD_CURRENT="$(current_release_path)"

stop_old_process

if [ -n "$OLD_CURRENT" ] && [ -d "$OLD_CURRENT" ]; then
  activate_release "$OLD_CURRENT" "previous"
  info "Saved previous release"
fi

activate_release "$RELEASE_DIR" "current"
info "New release activated"

CLIENT_PID="$(start_process "$RELEASE_DIR")"
ACTIVE_PID="$CLIENT_PID"
info "Waiting for client readiness (PID: $CLIENT_PID)..."

rc=0
wait_for_readiness "$CLIENT_PID" "$TUNNEL_READY_TIMEOUT_SECS" || rc=$?

if [ "$rc" -eq 0 ]; then
  ACTIVE_PID=""
  NEW_RELEASE_READY=true
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

if rollback_to_previous "$RELEASE_DIR"; then
  die "Installation failed; rolled back to the previous release"
fi

KEEP_FAILED_RELEASE=true
die "Installation failed and rollback could not restore a working $ROLE"
