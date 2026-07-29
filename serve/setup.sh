#!/usr/bin/env bash
set -euo pipefail

# =============================================================================
# Tunnel Client Installer
#
# Usage:
#   curl -fsSL https://<server>/<uuid>-install | bash
#
# Or with env vars:
#   curl -fsSL https://<server>/<uuid>-install \
#     | TUNNEL_SERVER_URL=wss://... TUNNEL_USERNAME=admin TUNNEL_PASSWORD=secret bash
# =============================================================================

WORK_DIR="${TUNNEL_WORK_DIR:-$HOME/.tunnel-client}"
SERVER_URL="${TUNNEL_SERVER_URL:-}"
USERNAME="${TUNNEL_USERNAME:-}"
PASSWORD="${TUNNEL_PASSWORD:-}"
TARGET="${TARGET_ORIGIN:-http://127.0.0.1:8000}"
INSTALL_UUID="${INSTALL_UUID:-__INSTALL_UUID__}"
READY_FILE="${WORK_DIR}/client.ready"
TUNNEL_PROMPT_INPUT="${TUNNEL_PROMPT_INPUT:-/dev/tty}"
LINK_NAME="current"
PREVIOUS_LINK_NAME="previous"
PROMPT_FD_OPEN=false

RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'; NC='\033[0m'
info()  { echo -e "${GREEN}[tunnel]${NC} $*"; }
warn()  { echo -e "${YELLOW}[tunnel]${NC} $*"; }
error() { echo -e "${RED}[tunnel]${NC} $*" >&2; }
die()   { error "$*"; exit 1; }

# --- Detect SERVER_URL ---
if [ -z "$SERVER_URL" ]; then
  if [ -n "${BASH_SOURCE[0]:-}" ] && [[ "${BASH_SOURCE[0]}" == http* ]]; then
    SERVER_URL="${BASH_SOURCE[0]}"
  fi
fi

# --- Open shared prompt input if any value needs interactive input ---
if [ -z "$SERVER_URL" ] || [ -z "$USERNAME" ] || [ -z "$PASSWORD" ]; then
  if exec 200< "$TUNNEL_PROMPT_INPUT" 2>/dev/null; then
    PROMPT_FD_OPEN=true
  else
    TUNNEL_PROMPT_INPUT=/dev/null
    exec 200< "$TUNNEL_PROMPT_INPUT"
    PROMPT_FD_OPEN=true
  fi
fi

if [ -z "$SERVER_URL" ]; then
  read -rp "Tunnel server URL (https://host/path): " SERVER_URL <&200
fi

WS_URL="$(echo "$SERVER_URL" | sed 's|^https://|wss://|; s|^http://|ws://|')"
if ! echo "$WS_URL" | grep -q '/tunnel$'; then
  WS_URL="${WS_URL%/}/tunnel"
fi

# --- Prompt for credentials ---
if [ -z "$USERNAME" ]; then
  read -rp "Tunnel username: " USERNAME <&200
fi
if [ -z "$PASSWORD" ]; then
  if [ -t 200 ]; then
    read -rsp "Tunnel password: " PASSWORD <&200
    echo
  else
    read -rp "Tunnel password: " PASSWORD <&200
  fi
fi

if [ "$PROMPT_FD_OPEN" = true ]; then
  exec 200<&-
  PROMPT_FD_OPEN=false
fi

[ -z "$USERNAME" ] && die "Username cannot be empty"
[ -z "$PASSWORD" ] && die "Password cannot be empty"

# --- Check Node.js ---
command -v node &>/dev/null || die "Node.js is not installed (>= 18 required)"
NODE_MAJOR=$(node -v | sed 's/v//' | cut -d. -f1)
[ "$NODE_MAJOR" -ge 18 ] 2>/dev/null || die "Node.js >= 18 required (found v$NODE_MAJOR)"
info "Node.js $(node -v)"

# --- Base URL for downloads ---
BASE_URL="$(echo "$SERVER_URL" | sed 's|^wss://|https://|; s|^ws://|http://|; s|/tunnel$||; s|/$||')"

# --- Atomic file write ---
download_atomic() {
  local url="$1" dest="$2"
  local tmp; tmp="$(mktemp "$dest.part.XXXXXX")"
  curl --fail --show-error --location -sS -o "$tmp" "$url"
  mv "$tmp" "$dest"
}

# --- Check for GNU mv -T ---
check_atomic_support() {
  local test_dir; test_dir="$(mktemp -d "${WORK_DIR}/.test.XXXXXX")"
  local test_a="${test_dir}/a"
  local test_b="${test_dir}/b"
  local test_link="${test_dir}/link"
  mkdir -p "$test_a" "$test_b"
  ln -s "$test_a" "${test_dir}/tmp_link"
  ln -s "$test_b" "$test_link"
  if ! mv -Tf "${test_dir}/tmp_link" "$test_link" 2>/dev/null; then
    rm -rf "$test_dir"
    die "GNU mv with -T support is required for atomic client activation"
  fi
  rm -rf "$test_dir"
}

# --- Atomic symlink replacement ---
activate_release() {
  local release_path="$1"
  local link_name="$2"
  local link_dir
  link_dir="$(mktemp -d "${WORK_DIR}/.link.XXXXXX")"
  LINK_DIRS+=("$link_dir")
  ln -s "$release_path" "${link_dir}/${link_name}"
  mv -Tf "${link_dir}/${link_name}" "${WORK_DIR}/${link_name}"
  rmdir "$link_dir"
}

# --- Readiness polling ---
wait_for_readiness() {
  local expected_pid="$1"
  local timeout_seconds="$2"
  local ready_pid=""
  local attempt

  for attempt in $(seq 1 "$timeout_seconds"); do
    ready_pid="$(cat "$READY_FILE" 2>/dev/null || true)"
    if [ "$ready_pid" = "$expected_pid" ] &&
       kill -0 "$expected_pid" 2>/dev/null; then
      return 0
    fi
    sleep 1
  done
  return 1
}

# --- Start the client as a background process ---
start_client() {
  local release_path="$1"
  rm -f "$READY_FILE"
  TUNNEL_SERVER_URL="$WS_URL" \
  TUNNEL_USERNAME="$USERNAME" \
  TUNNEL_PASSWORD="$PASSWORD" \
  TARGET_ORIGIN="$TARGET" \
  TUNNEL_READY_FILE="$READY_FILE" \
  TUNNEL_CAPTURE_FILE="${TUNNEL_CAPTURE_FILE:-}" \
    nohup node "${release_path}/client.js" \
    > "${WORK_DIR}/client.log" 2>&1 &
  CLIENT_PID=$!
  printf '%s\n' "$CLIENT_PID" > "${WORK_DIR}/client.pid"
}

# --- Stop existing client ---
stop_current_client() {
  if [ -f "${WORK_DIR}/client.pid" ]; then
    OLD_PID=$(cat "${WORK_DIR}/client.pid")
    if kill -0 "$OLD_PID" 2>/dev/null; then
      warn "Stopping existing client (PID: $OLD_PID)"
      kill "$OLD_PID" 2>/dev/null || true
      sleep 1
      kill -0 "$OLD_PID" 2>/dev/null && kill -9 "$OLD_PID" 2>/dev/null || true
    fi
    rm -f "${WORK_DIR}/client.pid"
  fi
  rm -f "$READY_FILE"
}

cleanup_failed_activation() {
  local failed_release="$1"
  local current_target=""

  if [ -L "${WORK_DIR}/${LINK_NAME}" ]; then
    current_target="$(readlink "${WORK_DIR}/${LINK_NAME}")"
  fi
  if [ "$current_target" = "$failed_release" ]; then
    rm -f "${WORK_DIR}/${LINK_NAME}"
  fi
  rm -f "${WORK_DIR}/client.pid" "$READY_FILE"
}

# =============================================================================
# Main installer logic
# =============================================================================

umask 077
mkdir -p "$WORK_DIR"

NEW_RELEASE_READY=false
LINK_DIRS=()

# --- Verify platform support ---
check_atomic_support

# --- Create release directory ---
mkdir -p "${WORK_DIR}/releases"
RELEASE_DIR="$(mktemp -d "${WORK_DIR}/releases/release.XXXXXXXX")"

# --- Clean up orphan releases on failure ---
cleanup_release() {
  if [ "$NEW_RELEASE_READY" = false ] && [ -d "$RELEASE_DIR" ]; then
    rm -rf "$RELEASE_DIR" || true
    warn "Removed orphan release: ${RELEASE_DIR}"
  fi
  for ld in "${LINK_DIRS[@]}"; do
    if [ -d "$ld" ]; then
      rmdir "$ld" 2>/dev/null || true
    fi
  done
}
trap cleanup_release EXIT

# --- Stage: download and validate new artifacts ---
info "Fetching client bundle..."
download_atomic "${BASE_URL}/${INSTALL_UUID}-client.js" "${RELEASE_DIR}/client.js"

info "Validating bundle..."
node --check "${RELEASE_DIR}/client.js"
info "Bundle OK"

info "Fetching client package manifest..."
download_atomic "${BASE_URL}/${INSTALL_UUID}-client-package.json" "${RELEASE_DIR}/package.json"

cat > "${RELEASE_DIR}/.env" <<EOF
TUNNEL_SERVER_URL=${WS_URL}
TUNNEL_USERNAME=${USERNAME}
TUNNEL_PASSWORD=${PASSWORD}
TARGET_ORIGIN=${TARGET}
EOF

chmod 600 "${RELEASE_DIR}/.env"
info "Created .env"

# --- Install dependencies ---
info "Installing dependencies..."
cd "$RELEASE_DIR"
if [ -f "package-lock.json" ]; then
  npm ci --omit=dev 2>/dev/null || npm install --omit=dev
elif [ -f "yarn.lock" ]; then
  yarn install --production 2>/dev/null || npm install --omit=dev
else
  npm install --omit=dev
fi
cd "$WORK_DIR"
info "Dependencies installed"

# --- Stop existing client ---
stop_current_client

# --- Save current release for rollback ---
PREVIOUS_RELEASE_BEFORE_INSTALL=""
if [ -L "${WORK_DIR}/${PREVIOUS_LINK_NAME}" ]; then
  PREVIOUS_RELEASE_BEFORE_INSTALL="$(readlink "${WORK_DIR}/${PREVIOUS_LINK_NAME}" 2>/dev/null || true)"
fi

if [ -L "${WORK_DIR}/${LINK_NAME}" ]; then
  OLD_RELEASE="$(readlink "${WORK_DIR}/${LINK_NAME}")"
  if [ -n "$OLD_RELEASE" ] && [ -d "$OLD_RELEASE" ]; then
    activate_release "$OLD_RELEASE" "$PREVIOUS_LINK_NAME"
    info "Saved previous release"
  fi
fi

# --- Activate the new release ---
activate_release "$RELEASE_DIR" "$LINK_NAME"
info "New release activated"

# --- Start the new client ---
start_client "$RELEASE_DIR"
info "Waiting for client readiness (PID: $CLIENT_PID)..."
if wait_for_readiness "$CLIENT_PID" 10; then
  NEW_RELEASE_READY=true
  info "Client ready (PID: $CLIENT_PID)"
  info "Logs: ${WORK_DIR}/client.log"
  info ""
  info "To stop:  kill \$(cat ${WORK_DIR}/client.pid)"
  info "To follow logs: tail -f ${WORK_DIR}/client.log"
else
  # Rollback - new client failed to become ready
  warn "Client readiness check failed"
  kill "$CLIENT_PID" 2>/dev/null || true
  warn "New client failed to start, rolling back..."

  PREVIOUS_RELEASE=""
  if [ -L "${WORK_DIR}/$PREVIOUS_LINK_NAME" ]; then
    PREVIOUS_RELEASE="$(readlink "${WORK_DIR}/$PREVIOUS_LINK_NAME")"
    if [ -z "$PREVIOUS_RELEASE" ] || [ ! -d "$PREVIOUS_RELEASE" ]; then
      PREVIOUS_RELEASE=""
    fi
  fi

  if [ -n "$PREVIOUS_RELEASE" ]; then
    warn "Restoring previous release: ${PREVIOUS_RELEASE}"
    activate_release "$PREVIOUS_RELEASE" "$LINK_NAME"

    if [ -n "$PREVIOUS_RELEASE_BEFORE_INSTALL" ] && [ -d "$PREVIOUS_RELEASE_BEFORE_INSTALL" ]; then
      activate_release "$PREVIOUS_RELEASE_BEFORE_INSTALL" "$PREVIOUS_LINK_NAME"
    else
      rm -f "${WORK_DIR}/${PREVIOUS_LINK_NAME}"
    fi

    start_client "$PREVIOUS_RELEASE"

    if wait_for_readiness "$CLIENT_PID" 10; then
      info "Rollback complete - previous client started (PID: $CLIENT_PID)"
      exit 0
    else
      error "Rollback failed - previous client did not become ready"
      die "Installation failed and rollback could not restore a working client"
    fi
  else
    cleanup_failed_activation "$RELEASE_DIR"
    error "No previous release to roll back to"
    die "Installation failed"
  fi
fi
