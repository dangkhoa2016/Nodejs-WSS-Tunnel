#!/usr/bin/env bash
set -euo pipefail

# =============================================================================
# TCP agent: expose a tunneled TCP service (e.g. Redis) to THIS external
# machine on a local port.
#
#   App -> 127.0.0.1:6379 -> tcp-agent.js -> WS /tcp -> Server
#        -> WS /tunnel -> client.js -> 127.0.0.1:6379 -> Redis (tunnel client)
#
# Run this ON THE EXTERNAL / APP-HOST MACHINE. The machine that hosts the
# service runs docs/setup-tunnel-client.sh instead.
#
# Usage:
#   1) Copy this file to the external machine (Node.js >= 18 + npm + curl).
#   2) Fill in the CONFIG section below.
#   3) bash setup-tcp-agent.sh
#      Credentials are read from AGENT_USERNAME / AGENT_PASSWORD (or
#      TUNNEL_USERNAME / TUNNEL_PASSWORD) env vars, otherwise prompted.
#   4) Point your app at:  redis://:<REDIS_PASSWORD>@127.0.0.1:6379
#
# Optional env overrides:
#   INSTALL_UUID       server INSTALL_UUID used in artifact URLs (default: CONFIG)
#   AGENT_BUNDLE_URL   URL that serves tcp-agent.js (default: <server>/<INSTALL_UUID>-tcp-agent.js)
#   AGENT_BUNDLE_PATH  local path to tcp-agent.js (skips download)
#   AGENT_PORTS        local ports to expose (default 6379)
#   AGENT_DIR          working directory (default ~/.redis-agent)
# =============================================================================

# --- CONFIG ----------------------------------------------------------------
SERVER_HOST="<server-host>"            # e.g. crispy-memory-xxxx-7860.app.github.dev
INSTALL_UUID="${INSTALL_UUID:-<server-install-uuid>}"  # server INSTALL_UUID (see guide, section 3.1)
REDIS_PASSWORD="${REDIS_PASSWORD:-<redis-password>}"   # Redis requirepass on the tunnel-client machine
# ----------------------------------------------------------------------------

WS_URL="wss://$SERVER_HOST/tcp"

AGENT_DIR="${AGENT_DIR:-$HOME/.redis-agent}"
AGENT_PORTS="${AGENT_PORTS:-6379}"
AGENT_BIND_HOST="${AGENT_BIND_HOST:-127.0.0.1}"

RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'; NC='\033[0m'
info()  { echo -e "${GREEN}[tcp-setup]${NC} $*"; }
warn()  { echo -e "${YELLOW}[tcp-setup]${NC} $*"; }
error() { echo -e "${RED}[tcp-setup]${NC} $*" >&2; }
die()   { error "$*"; exit 1; }

# --- 1. Prerequisites --------------------------------------------------------
command -v node &>/dev/null || die "Node.js is not installed (>= 18 required)"
NODE_MAJOR=$(node -v | sed 's/v//' | cut -d. -f1)
[ "$NODE_MAJOR" -ge 18 ] 2>/dev/null || die "Node.js >= 18 required (found v$NODE_MAJOR)"
command -v npm &>/dev/null || die "npm is not installed"
command -v curl &>/dev/null || die "curl is not installed"
info "Prerequisites OK (Node.js $(node -v))"

# --- 2. Credentials -----------------------------------------------------------
AGENT_USERNAME="${AGENT_USERNAME:-${TUNNEL_USERNAME:-}}"
AGENT_PASSWORD="${AGENT_PASSWORD:-${TUNNEL_PASSWORD:-}}"

if [ -z "$AGENT_USERNAME" ]; then
  read -rp "Agent username (server TCP_AGENT_USERNAME): " AGENT_USERNAME </dev/tty
fi
if [ -z "$AGENT_PASSWORD" ]; then
  read -rsp "Agent password (server TCP_AGENT_PASSWORD): " AGENT_PASSWORD </dev/tty
  echo
fi
[ -z "$AGENT_USERNAME" ] && die "Agent username cannot be empty"
[ -z "$AGENT_PASSWORD" ] && die "Agent password cannot be empty"

# --- 3. Obtain the agent bundle -------------------------------------------------
mkdir -p "$AGENT_DIR"
cd "$AGENT_DIR"

# 3a. package.json first: it declares "type": "module" so node --check and the
#     ESM agent bundle work on older Node releases.
if [ ! -f package.json ]; then
  if curl -fsSL "https://$SERVER_HOST/$INSTALL_UUID-tcp-agent-package.json" -o package.json 2>/dev/null; then
    info "Fetched package manifest from server"
  else
    printf '{"type":"module","private":true,"dependencies":{"ws":"^8.21.1"}}\n' > package.json
    warn "Wrote minimal package.json (server manifest unavailable)"
  fi
fi

# 3b. dependency
if [ ! -d node_modules/ws ]; then
  info "Installing dependency (ws) ..."
  npm install --omit=dev 2>/dev/null || npm install ws || die "Failed to install 'ws'"
else
  info "Dependency 'ws' already present"
fi

# 3c. the agent bundle
if [ -n "${AGENT_BUNDLE_PATH:-}" ]; then
  info "Using local bundle: $AGENT_BUNDLE_PATH"
  cp "$AGENT_BUNDLE_PATH" tcp-agent.js
elif [ -f tcp-agent.js ] && node --check tcp-agent.js 2>/dev/null; then
  info "Using existing bundle: $AGENT_DIR/tcp-agent.js"
else
  BUNDLE_URL="${AGENT_BUNDLE_URL:-https://$SERVER_HOST/$INSTALL_UUID-tcp-agent.js}"
  info "Downloading agent bundle from $BUNDLE_URL ..."
  if ! curl -fsSL "$BUNDLE_URL" -o tcp-agent.js; then
    error "Failed to download tcp-agent.js from $BUNDLE_URL"
    error ""
    error "If the server returns HTTP 5xx for /<INSTALL_UUID>-tcp-agent.js, rebuild the server bundles:"
    error "  cd <server-repo> && yarn build:client   # generates dist/tcp-agent.js"
    error "then restart the server, or set AGENT_BUNDLE_URL / AGENT_BUNDLE_PATH."
    die "Agent bundle is required"
  fi
fi

node --check tcp-agent.js || die "tcp-agent.js failed validation"

# --- 4. Stop any running agent ------------------------------------------------
if [ -f agent.pid ]; then
  OLD_PID=$(cat agent.pid)
  if kill -0 "$OLD_PID" 2>/dev/null; then
    warn "Stopping existing agent (PID: $OLD_PID)"
    kill "$OLD_PID" 2>/dev/null || true
    sleep 1
    kill -0 "$OLD_PID" 2>/dev/null && kill -9 "$OLD_PID" 2>/dev/null || true
  fi
  rm -f agent.pid
fi
rm -f agent.log

# --- 5. Start agent ------------------------------------------------------------
info "Starting TCP agent on ${AGENT_BIND_HOST}:${AGENT_PORTS} ..."
nohup env \
  TUNNEL_SERVER_URL="$WS_URL" \
  AGENT_USERNAME="$AGENT_USERNAME" \
  AGENT_PASSWORD="$AGENT_PASSWORD" \
  AGENT_PORTS="$AGENT_PORTS" \
  AGENT_BIND_HOST="$AGENT_BIND_HOST" \
  node tcp-agent.js > agent.log 2>&1 &
AGENT_PID=$!
echo "$AGENT_PID" > agent.pid

# --- 6. Wait for readiness ------------------------------------------------------
info "Waiting for agent readiness (PID: $AGENT_PID) ..."
READY=false
for _ in $(seq 1 15); do
  if grep -q "Connected to tunnel server" agent.log 2>/dev/null; then
    READY=true
    break
  fi
  if grep -q "Authentication failed" agent.log 2>/dev/null; then
    break
  fi
  if ! kill -0 "$AGENT_PID" 2>/dev/null; then
    break
  fi
  sleep 1
done

if [ "$READY" = true ]; then
  info "Agent connected to tunnel server."
  info ""
  info "Now point your app at:  redis://:$REDIS_PASSWORD@127.0.0.1:6379"
  info ""
  info "Test with:"
  info "  redis-cli -h 127.0.0.1 -p 6379 -a $REDIS_PASSWORD ping   # expect PONG"
  info "  tail -f $AGENT_DIR/agent.log"
  info "  kill \$(cat $AGENT_DIR/agent.pid)   # to stop"
  exit 0
fi

error "Agent did not become ready. Last log:"
cat agent.log
if grep -q "Authentication failed" agent.log 2>/dev/null; then
  die "Wrong agent credentials. Check AGENT_USERNAME / AGENT_PASSWORD (server TCP_AGENT_USERNAME / TCP_AGENT_PASSWORD)."
fi
die "See $AGENT_DIR/agent.log for details"
