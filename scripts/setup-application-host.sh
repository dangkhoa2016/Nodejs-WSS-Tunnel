#!/usr/bin/env bash
set -euo pipefail

# Install one TCP agent on an application host (Computer B, C, D, ...).
# Required: SERVER_HOST, INSTALL_UUID and matching agent/tunnel credentials.

SERVER_HOST="${SERVER_HOST:-}"
INSTALL_UUID="${INSTALL_UUID:-}"
AGENT_DIR="${AGENT_DIR:-$HOME/.tcp-agent}"
AGENT_PORTS="${AGENT_PORTS:-6379,5432}"
AGENT_BIND_HOST="${AGENT_BIND_HOST:-127.0.0.1}"

info() { printf '[application-host] %s\n' "$*"; }
die() { printf '[application-host] ERROR: %s\n' "$*" >&2; exit 1; }

[ -n "$SERVER_HOST" ] || die 'SERVER_HOST is required and must match the service host'
[ -n "$INSTALL_UUID" ] || die 'INSTALL_UUID is required and must match the service host'
case "$SERVER_HOST" in
  http://*|https://*|ws://*|wss://*|*/*) die 'SERVER_HOST must contain only a hostname' ;;
esac
[ "$AGENT_BIND_HOST" = 127.0.0.1 ] || [ "${ALLOW_REMOTE_AGENT_BIND:-0}" = 1 ] || \
  die 'Refusing a non-loopback bind; set ALLOW_REMOTE_AGENT_BIND=1 only with a firewall'

command -v node >/dev/null || die 'Node.js 18 or newer is required'
command -v npm >/dev/null || die 'npm is required'
command -v curl >/dev/null || die 'curl is required'
NODE_MAJOR=$(node -p 'Number(process.versions.node.split(".")[0])')
[ "$NODE_MAJOR" -ge 18 ] || die "Node.js 18 or newer is required (found $(node -v))"

AGENT_USERNAME="${AGENT_USERNAME:-${TUNNEL_USERNAME:-}}"
AGENT_PASSWORD="${AGENT_PASSWORD:-${TUNNEL_PASSWORD:-}}"
if [ -z "$AGENT_USERNAME" ]; then
  [ -r /dev/tty ] || die 'AGENT_USERNAME is required in non-interactive mode'
  read -rp 'Agent username: ' AGENT_USERNAME </dev/tty
fi
if [ -z "$AGENT_PASSWORD" ]; then
  [ -r /dev/tty ] || die 'AGENT_PASSWORD is required in non-interactive mode'
  read -rsp 'Agent password: ' AGENT_PASSWORD </dev/tty
  printf '\n' >/dev/tty
fi
[ -n "$AGENT_USERNAME" ] || die 'Agent username cannot be empty'
[ -n "$AGENT_PASSWORD" ] || die 'Agent password cannot be empty'

mkdir -p "$AGENT_DIR"
chmod 700 "$AGENT_DIR"
cd "$AGENT_DIR"

if [ ! -f package.json ] || [ "${AGENT_BUNDLE_REFRESH:-0}" = 1 ]; then
  if ! curl -fsSL "https://$SERVER_HOST/$INSTALL_UUID-tcp-agent-package.json" -o package.json; then
    printf '{"type":"module","private":true,"dependencies":{"ws":"^8.21.3"}}\n' >package.json
    info 'Server manifest unavailable; wrote the compatible fallback manifest'
  fi
fi

if [ ! -d node_modules/ws ]; then
  npm install --omit=dev || die 'Failed to install agent dependencies'
fi

if [ -n "${AGENT_BUNDLE_PATH:-}" ]; then
  cp "$AGENT_BUNDLE_PATH" tcp-agent.js
elif [ ! -f tcp-agent.js ] || [ "${AGENT_BUNDLE_REFRESH:-0}" = 1 ] || ! node --check tcp-agent.js >/dev/null 2>&1; then
  BUNDLE_URL="${AGENT_BUNDLE_URL:-https://$SERVER_HOST/$INSTALL_UUID-tcp-agent.js}"
  curl -fsSL "$BUNDLE_URL" -o tcp-agent.js || die "Failed to download $BUNDLE_URL"
fi
node --check tcp-agent.js || die 'Downloaded tcp-agent.js is invalid'

if [ -f agent.pid ]; then
  OLD_PID=$(cat agent.pid)
  if [[ "$OLD_PID" =~ ^[0-9]+$ ]] && kill -0 "$OLD_PID" 2>/dev/null; then
    OLD_COMMAND=$(ps -p "$OLD_PID" -o args= 2>/dev/null || true)
    [[ "$OLD_COMMAND" == *tcp-agent.js* ]] || die "PID $OLD_PID does not belong to tcp-agent.js"
    kill "$OLD_PID"
    for _ in $(seq 1 20); do
      kill -0 "$OLD_PID" 2>/dev/null || break
      sleep 0.1
    done
    kill -0 "$OLD_PID" 2>/dev/null && kill -9 "$OLD_PID" 2>/dev/null || true
  fi
fi
rm -f agent.pid agent.log

info "Starting agent on $AGENT_BIND_HOST for ports $AGENT_PORTS"
nohup env \
  TUNNEL_SERVER_URL="wss://$SERVER_HOST/tcp" \
  AGENT_USERNAME="$AGENT_USERNAME" \
  AGENT_PASSWORD="$AGENT_PASSWORD" \
  AGENT_PORTS="$AGENT_PORTS" \
  AGENT_BIND_HOST="$AGENT_BIND_HOST" \
  VERBOSE="${VERBOSE:-false}" \
  LOG_FORMAT="${LOG_FORMAT:-text}" \
  node tcp-agent.js >agent.log 2>&1 &
AGENT_PID=$!
printf '%s\n' "$AGENT_PID" >agent.pid
chmod 600 agent.pid agent.log

for _ in $(seq 1 30); do
  if grep -Eq '\[agent\] connected|"cat":"agent","evt":"connected"' agent.log; then
    info 'Connected. Applications may use the loopback service ports.'
    info "Redis: REDISCLI_AUTH='<redis-password>' redis-cli -h 127.0.0.1 -p 6379 ping"
    info "PostgreSQL: PGPASSWORD='<password>' psql -h 127.0.0.1 -p 5432 -U '<user>' -d '<db>' -c 'SELECT 1'"
    info "Log: $AGENT_DIR/agent.log"
    exit 0
  fi
  if grep -Eq '\[agent\] auth_failed|"cat":"agent","evt":"auth_failed"' agent.log; then
    cat agent.log >&2
    die 'Agent credentials were rejected'
  fi
  kill -0 "$AGENT_PID" 2>/dev/null || break
  sleep 0.5
done

cat agent.log >&2
die "Agent did not become ready; inspect $AGENT_DIR/agent.log"
