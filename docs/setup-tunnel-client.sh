#!/usr/bin/env bash
set -euo pipefail

# =============================================================================
# Tunnel client: share a LOCAL service (e.g. Redis on 127.0.0.1:6379) with the
# Internet through the Nodejs-WSS-Tunnel server.
#
#   Redis 127.0.0.1:6379 <- client.js <- WS /tunnel <- Server <- TCP agent
#
# Run this ON THE MACHINE THAT HOSTS THE SERVICE (e.g. the Redis box). It only
# pipes the server-provided installer to bash; the installer handles the
# install/upgrade, the PID file and logging.
#
# Prerequisites on this machine: Node.js >= 18 and curl.
#
# Usage:
#   1) Fill in the CONFIG section below (see "Where to get these values").
#   2) bash setup-tunnel-client.sh
#   3) Logs: tail -f ~/.tunnel-client/client.log
#      Stop: kill $(cat ~/.tunnel-client/client.pid)
# =============================================================================

# --- CONFIG ----------------------------------------------------------------
SERVER_HOST="<server-host>"            # e.g. crispy-memory-xxxx-7860.app.github.dev
INSTALL_UUID="<server-install-uuid>"   # server INSTALL_UUID (see guide, section 3.1)
TUNNEL_USERNAME="<server-tunnel-username>"
TUNNEL_PASSWORD="<server-tunnel-password>"
TARGET_ORIGIN="http://127.0.0.1:8000"  # HTTP tunnel target (unused by TCP/Redis)
# ----------------------------------------------------------------------------

export TUNNEL_SERVER_URL="wss://$SERVER_HOST/tunnel"
export TUNNEL_USERNAME
export TUNNEL_PASSWORD
export TARGET_ORIGIN

INSTALL_URL="https://$SERVER_HOST/$INSTALL_UUID-install"
echo "Installing tunnel client from: $INSTALL_URL"
curl -fsSL "$INSTALL_URL" | bash

echo
echo "Client installed."
echo "  Logs: tail -f ~/.tunnel-client/client.log   (look for \"[standard] [client] connected\")"
echo "  Stop: kill \$(cat ~/.tunnel-client/client.pid)"
echo
echo "Where to get these values:"
echo "  <server-host>         from the tunnel server administrator"
echo "  <server-install-uuid> field installUuid=... in the server's startup log"
echo "                        line \"[standard] [ws] startup ...\"; pin it in the"
echo "                        server's .env as INSTALL_UUID=... so URLs stay stable"
echo "  <server-tunnel-username> / <server-tunnel-password>"
echo "                        the server's TUNNEL_USERNAME / TUNNEL_PASSWORD"
