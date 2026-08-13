#!/usr/bin/env bash
set -euo pipefail

# Install the tunnel client on the host that owns Redis/PostgreSQL.
# Required: SERVER_HOST, INSTALL_UUID, TUNNEL_USERNAME, TUNNEL_PASSWORD.

SERVER_HOST="${SERVER_HOST:-}"
INSTALL_UUID="${INSTALL_UUID:-}"
CLIENT_DIR="${CLIENT_DIR:-$HOME/.tunnel-client}"
SERVICE_HOST="${TCP_TUNNEL_HOST:-127.0.0.1}"

info() { printf '[service-host] %s\n' "$*"; }
die() { printf '[service-host] ERROR: %s\n' "$*" >&2; exit 1; }

[ -n "$SERVER_HOST" ] || die 'SERVER_HOST is required and must be shared with every application host'
[ -n "$INSTALL_UUID" ] || die 'INSTALL_UUID is required and must be pinned on the server'
case "$SERVER_HOST" in
  http://*|https://*|ws://*|wss://*|*/*) die 'SERVER_HOST must contain only a hostname' ;;
esac

command -v node >/dev/null || die 'Node.js 18 or newer is required'
command -v npm >/dev/null || die 'npm is required'
command -v curl >/dev/null || die 'curl is required'
NODE_MAJOR=$(node -p 'Number(process.versions.node.split(".")[0])')
[ "$NODE_MAJOR" -ge 18 ] || die "Node.js 18 or newer is required (found $(node -v))"

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

mkdir -p "$CLIENT_DIR"
chmod 700 "$CLIENT_DIR"
cd "$CLIENT_DIR"

if [ ! -f package.json ] || [ "${CLIENT_BUNDLE_REFRESH:-0}" = 1 ]; then
  if ! curl -fsSL "https://$SERVER_HOST/$INSTALL_UUID-client-package.json" -o package.json; then
    printf '{"type":"module","private":true,"dependencies":{"ws":"^8.21.3"}}\n' >package.json
    info 'Server manifest unavailable; wrote the compatible fallback manifest'
  fi
fi

if [ ! -d node_modules/ws ]; then
  npm install --omit=dev || die 'Failed to install client dependencies'
fi

if [ -n "${CLIENT_BUNDLE_PATH:-}" ]; then
  cp "$CLIENT_BUNDLE_PATH" client.js
elif [ ! -f client.js ] || [ "${CLIENT_BUNDLE_REFRESH:-0}" = 1 ] || ! node --check client.js >/dev/null 2>&1; then
  BUNDLE_URL="${CLIENT_BUNDLE_URL:-https://$SERVER_HOST/$INSTALL_UUID-client.js}"
  curl -fsSL "$BUNDLE_URL" -o client.js || die "Failed to download $BUNDLE_URL"
fi
node --check client.js || die 'Downloaded client.js is invalid'

if [ -f client.pid ]; then
  OLD_PID=$(cat client.pid)
  if [[ "$OLD_PID" =~ ^[0-9]+$ ]] && kill -0 "$OLD_PID" 2>/dev/null; then
    OLD_COMMAND=$(ps -p "$OLD_PID" -o args= 2>/dev/null || true)
    [[ "$OLD_COMMAND" == *client.js* ]] || die "PID $OLD_PID does not belong to client.js"
    kill "$OLD_PID"
    for _ in $(seq 1 20); do
      kill -0 "$OLD_PID" 2>/dev/null || break
      sleep 0.1
    done
    kill -0 "$OLD_PID" 2>/dev/null && kill -9 "$OLD_PID" 2>/dev/null || true
  fi
fi
rm -f client.pid client.log

info "Starting tunnel client for services on $SERVICE_HOST"
nohup env \
  TUNNEL_SERVER_URL="wss://$SERVER_HOST/tunnel" \
  TUNNEL_USERNAME="$TUNNEL_USERNAME" \
  TUNNEL_PASSWORD="$TUNNEL_PASSWORD" \
  TCP_TUNNEL_HOST="$SERVICE_HOST" \
  TCP_CLIENT_ALLOWED_HOSTS="${TCP_CLIENT_ALLOWED_HOSTS:-$SERVICE_HOST}" \
  TCP_CONNECT_TIMEOUT_MS="${TCP_CONNECT_TIMEOUT_MS:-10000}" \
  VERBOSE="${VERBOSE:-false}" \
  LOG_FORMAT="${LOG_FORMAT:-text}" \
  node client.js >client.log 2>&1 &
CLIENT_PID=$!
printf '%s\n' "$CLIENT_PID" >client.pid
chmod 600 client.pid client.log

for _ in $(seq 1 30); do
  if grep -Eq '\[client\] connected|"cat":"client","evt":"connected"' client.log; then
    info "Connected. Application hosts may now start their TCP agents."
    info "Log: $CLIENT_DIR/client.log"
    exit 0
  fi
  if grep -Eq '\[client\] auth_failed|"cat":"client","evt":"auth_failed"' client.log; then
    cat client.log >&2
    die 'Tunnel credentials were rejected'
  fi
  kill -0 "$CLIENT_PID" 2>/dev/null || break
  sleep 0.5
done

cat client.log >&2
die "Client did not become ready; inspect $CLIENT_DIR/client.log"
