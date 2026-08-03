# Nodejs WSS Tunnel (HTTP-over-WebSocket Reverse Tunnel)

[![CI](https://github.com/dangkhoa2016/Nodejs-WSS-Tunnel/actions/workflows/ci.yml/badge.svg)](https://github.com/dangkhoa2016/Nodejs-WSS-Tunnel/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

> 🌐 Language / Ngôn ngữ: **English** | [Tiếng Việt](README.vi.md)

HTTP-over-WebSocket reverse tunnel with TCP tunneling support (direct + TCP agent mode), built on a binary multiplexing protocol. Expose local web UI applications (Stable Diffusion WebUI, Ollama, ComfyUI, etc.) running in connection-restricted environments (Google Colab, Kaggle, local PC) to the Internet through an intermediary server.

---

## System Architecture

```
                                       +------------------------------------------+
                                       |   Tunnel Client (Colab/Kaggle)           |
                                       |         (dist/client.js)                 |
                                       +--------------------+---------------------+
                                                            | WebSocket (Binary Frames)
                                                            | Basic Auth required
                                                            v
+------------------+   HTTP Request   +---------------------+---------------------+   HTTP Request   +-------------------+
|  End User Browser| ---------------> |      Intermediary Server (Node.js)       | ---------------> | Local Target App  |
|  (Public Web)    | <--------------- |  TunnelServer / HttpRouter / TcpRouter   | <--------------- | (e.g. 127.0.0.1:8000)|
+------------------+   HTTP Response  +---------------------+-----+---------------+   HTTP Response  +-------------------+
                                                            ^     ^
                                             TCP direct mode|     |TCP agent mode
                            +--------------------------------+     +--------------------------------+
                            | External TCP Client            |     | TCP Agent (app host)           |
                            | (Rails / redis-cli)            |     |  (dist/tcp-agent.js)           |
                            | -> server:<TCP_TUNNEL_PORT>    |     |  local listener :AGENT_PORTS   |
                            +--------------------------------+     +--------------------------------+
                                                                                | TCP (loopback)
                                                                                v
                                                                 +--------------------------------+
                                                                 | Local service on the app host  |
                                                                 | (Redis/Postgres/MySQL/etc.)    |
                                                                 +--------------------------------+
```

### Key Features
1. **Ultra-Lightweight Binary Protocol**: 6-byte header `[Version(1B) | Type(1B) | StreamID(4B)]` optimizes bandwidth and CPU usage.
2. **Backpressure & Flow Control**: Supports `PAUSE`/`RESUME` control frames combined with `bufferedAmount` to prevent memory leaks.
3. **TCP Tunnel Support**: Raw TCP tunneling (Redis, Postgres, MySQL, etc.) alongside HTTP, with bidirectional backpressure, in two modes:
   - **Direct**: the server listens on `TCP_TUNNEL_PORTS` and relays each connection to a TCP service on the tunnel client machine (IPv4/CIDR allowlist supported).
   - **TCP agent**: a standalone `tcp-agent.js` on the app host exposes local ports through the server's `/tcp` WebSocket endpoint, so no inbound port is needed on the server (PaaS-friendly).
4. **Security**:
   - WebSocket authentication via HTTP Basic Auth (required, constant-time comparison).
   - Admin config endpoint protected by time-limited HMAC-SHA256 signed URLs.
   - TCP connections filtered by IPv4 IP allowlist (CIDR support).
5. **One-Line Client Installation**: Downloads the standalone bundle and configures via `setup.sh`.
6. **Transactional Upgrades**: Installer downloads to a staging directory, validates the bundle (`node --check`), then atomically swaps files. The old client is preserved if staging fails.
7. **TTY-Free Installation**: All prompts accept environment variables (`TUNNEL_SERVER_URL`, `TUNNEL_USERNAME`, `TUNNEL_PASSWORD`, `TARGET_ORIGIN`), enabling fully automated headless deployment.
8. **Standalone Bundles**: The tunnel client and the TCP agent are pre-built (esbuild) into `dist/client.js` and `dist/tcp-agent.js` -- no server source tree needed to run tunnel clients or agents.
9. **Graceful Shutdown**: On SIGTERM/SIGINT, the server drains active streams, closes TCP listeners, and exits cleanly with no `--test-force-exit` flag needed.
10. **Health Checks**: Endpoints `/__health` and `/healthz` always return `200 ok`.

---

## Directory Structure

```text
.
├── biome.json              # Lint and format configuration (Biome)
├── .env.example            # Env variable INDEX (points to the two templates)
├── .env.example.vps        # Full env template: VPS / dedicated host (direct TCP)
├── .env.example.single-port # Full env template: Render/Railway/Fly.io/Codespaces (agent mode)
├── dist/
│   ├── client.js           # Standalone esbuild bundle for tunnel clients (~48KB, no server deps)
│   └── tcp-agent.js        # Standalone esbuild bundle for TCP agents (~29KB, no server deps)
├── docs/
│   ├── tcp-tunnel.md                             # Detailed TCP tunnel & TCP agent guide (EN)
│   ├── tcp-tunnel.vi.md                          # Detailed TCP tunnel & TCP agent guide (VI)
│   ├── guide-external-app-to-tcp-services.md     # Guide: connect an external app (e.g. Redis) to tunneled TCP services (EN)
│   ├── guide-external-app-to-tcp-services.vi.md  # Guide: connect an external app (e.g. Redis) to tunneled TCP services (VI)
│   ├── setup-tcp-agent.sh                        # Script: expose a tunneled TCP service (e.g. Redis) to this machine
│   └── setup-tunnel-client.sh                    # Script: share a local service (e.g. Redis) with the Internet
├── serve/
│   ├── build.js            # esbuild bundler script (builds client.js + tcp-agent.js)
│   ├── client.js           # Tunnel client source (imports shared modules)
│   ├── tcp-agent.js        # TCP agent source (local listeners, relays over WS /tcp)
│   ├── setup.sh            # One-line client installation & launch script
│   ├── client-package.json # Minimal package.json for client-only install
│   └── tcp-agent-package.json # Minimal package.json for agent-only install
├── src/
│   ├── index.js             # Server entry point
│   ├── server/              # Core HTTP tunnel server
│   │   ├── TunnelServer.js  # HTTP Server & WebSocketServer (ws) init, graceful shutdown
│   │   ├── ClientManager.js # WebSocket clients, heartbeat & lifecycle
│   │   ├── HttpRouter.js    # HTTP routing, static files, health checks, WebSocket upgrade
│   │   ├── StreamManager.js # HTTP + TCP stream multiplexing lifecycle
│   │   └── WsFrameWriter.js # Writable stream for WebSocket binary data
│   ├── tcp/                 # TCP tunnel subsystem
│   │   ├── TcpRouter.js     # TCP tunnel listeners (direct mode), IP allowlist, backpressure
│   │   ├── TcpAgentServer.js # TCP agent WebSocket endpoint (/tcp), port & stream limits
│   │   ├── VirtualSocket.js # Server-side virtual socket bridging agent and tunnel client
│   │   ├── TcpFlowControl.js # Pause/resume sync for TCP socket backpressure
│   │   └── TcpClientHandler.js # Client-side TCP frame handlers
│   └── shared/              # Shared infrastructure
│       ├── config.js        # Environment variable loading & validation
│       ├── protocol.js      # FrameCodec & binary protocol constants (shared)
│       ├── utils.js         # HMAC, SafeEqual, Sanitize Headers
│       ├── ipAllowlist.js   # IPv4/CIDR matcher
│       ├── logging.js       # Logging core implementation
│       └── logger.js        # Logging facade (text / JSON, verbose)
├── public/                 # Landing page assets
├── test/                    # Test suite (built-in node:test runner)
│   ├── server/              # Core server tests
│   │   ├── artifact-routes.test.js
│   │   ├── config-endpoint.test.js
│   │   ├── shutdown.test.js
│   │   ├── stream-manager.test.js
│   │   ├── stream-manager-tcp.test.js
│   │   └── websocket-auth.test.js
│   ├── tcp/                 # TCP tunnel tests
│   │   ├── tcp-agent-e2e.test.js
│   │   ├── tcp-agent-process.test.js
│   │   ├── tcp-agent-server.test.js
│   │   ├── tcp-cleanup.test.js
│   │   ├── tcp-client-handler.test.js
│   │   ├── tcp-e2e.test.js
│   │   ├── tcp-entry-e2e.test.js
│   │   ├── tcp-flow-control.test.js
│   │   ├── tcp-open-ack.test.js
│   │   ├── tcp-real-integration.test.js
│   │   ├── tcp-router.test.js
│   │   ├── tcp-stress.test.js
│   │   └── virtual-socket.test.js
│   ├── shared/              # Shared module tests
│   │   ├── config-validation.test.js
│   │   ├── ip-allowlist.test.js
│   │   ├── logger.test.js
│   │   └── utils.test.js
│   ├── client/              # Client bundle tests
│   │   ├── client-build.test.js
│   │   └── client-reconnect.test.js
│   ├── installer/           # Installer tests
│   │   ├── installer.test.js
│   │   └── installer-e2e.test.js
│   ├── helpers/
│   │   └── tcp-test-setup.js
│   └── fixtures/
│       ├── client-captures-env.js
│       ├── client-exits.js
│       ├── client-never-ready.js
│       └── client-writes-ready.js
├── LICENSE
├── package.json
├── TESTING.md              # Detailed testing instructions (EN)
├── TESTING.vi.md           # Detailed testing instructions (VI)
├── yarn.lock
├── .github/workflows/ci.yml # CI: tests on Node 20/22/24 with Redis + Postgres
└── Dockerfile
```

### Detailed Documentation

For more detail, see the guides under `docs/`:
- [TCP Tunnel & TCP Agent Guide (English)](docs/tcp-tunnel.md)
- [TCP Tunnel & TCP Agent Guide (Vietnamese)](docs/tcp-tunnel.vi.md)
- [Connecting an External App to TCP Services (Redis) (English)](docs/guide-external-app-to-tcp-services.md)
- [Connecting an External App to TCP Services (Vietnamese)](docs/guide-external-app-to-tcp-services.vi.md)

---

## Server Setup Guide

### Requirements
- **Node.js**: >= 18.0.0
- **Package Manager**: Yarn (recommended) or npm

### Quick Start

```bash
# Clone and install
git clone <repo> && cd Nodejs-WSS-Tunnel
corepack enable && yarn install

# Configure -- copy ONE of the two mode-specific templates (see below)
cp .env.example.vps .env            # VPS / dedicated host (direct TCP mode)
# cp .env.example.single-port .env  # Render/Railway/Fly.io/Codespaces (agent mode)
# Edit .env with your settings (TUNNEL_USERNAME and TUNNEL_PASSWORD required)

# Start
yarn prod
```

> `yarn dev` builds the bundles first (`node serve/build.js && ...`), so the bundles served to tunnel clients and TCP agents stay up to date while developing. `yarn prod` does **not** build automatically -- run `yarn build:client` once before starting (the `Dockerfile` builds at image build time).

### Build Client Bundle

> **Important:** `dist/` is **not committed to git** (see `.gitignore`) -- a fresh clone has no `dist/` directory. The server serves these bundles to tunnel clients and TCP agents at `/${INSTALL_UUID}-client.js` and `/${INSTALL_UUID}-tcp-agent.js`. If `dist/` is **missing**, those URLs return `500 Internal Server Error` and client/agent installation fails; if it is **stale**, clients download outdated code that may be incompatible with the current server.

```bash
yarn build:client
```

Produces `dist/client.js` (tunnel client) and `dist/tcp-agent.js` (TCP agent) -- the standalone esbuild bundles served to tunnel clients and TCP agents. Neither requires the server source tree.

`yarn dev` builds automatically first (`node serve/build.js && NODE_ENV=development node src/index.js`), so `dist/` is regenerated before the dev server starts. `yarn prod` does **not** build -- run `yarn build:client` manually before starting (for example, after editing `serve/client.js` or `serve/tcp-agent.js`).

The `Dockerfile` also runs `yarn build:client` at image build time, so Docker deployments are unaffected.

### Environment Variables

> `.env.example` is only an **index** -- the full commented templates are `.env.example.vps` (direct TCP mode, server binds `TCP_TUNNEL_PORTS`) and `.env.example.single-port` (agent mode, `TCP_AGENT_ALLOWED_PORTS`). The most common settings are shown below; see the templates for every variable and its default. `.env` is auto-loaded only when `NODE_ENV` is unset or `development`.

```env
NODE_ENV=development
PORT=7860
TUNNEL_PATH=/tunnel
SERVER_HOST=https://your-server-host
INSTALL_UUID=

# Required -- WebSocket clients must authenticate
TUNNEL_USERNAME=your_username
TUNNEL_PASSWORD=your_password

# HTTP stream limits
MAX_CONCURRENT_STREAMS=200
STREAM_IDLE_TIMEOUT_MS=120000
HTTP_REQUEST_TIMEOUT_MS=0

# WebSocket / frame limits
WS_HIGH_WATER_BYTES=1048576
WS_LOW_WATER=524288
MAX_FRAME_PAYLOAD_BYTES=262144
WS_MAX_PAYLOAD_BYTES=2097152

# Buffering
MAX_DEST_BUFFER_BYTES=8388608
DRAIN_TIMEOUT_MS=30000

# TCP tunnel (optional, direct mode)
TCP_TUNNEL_HOST=127.0.0.1
TCP_TUNNEL_PORTS=6379,5432
TCP_TUNNEL_BIND_HOST=127.0.0.1
TCP_TUNNEL_ALLOWED_IPS=127.0.0.1
TCP_CLIENT_ALLOWED_HOSTS=127.0.0.1
TCP_CONNECT_TIMEOUT_MS=10000
TCP_MAX_CONNECTIONS_PER_PORT=20
TCP_SHUTDOWN_DRAIN_TIMEOUT_MS=5000

# TCP agent over WebSocket (optional, agent mode)
TCP_AGENT_PATH=/tcp
TCP_AGENT_ALLOWED_PORTS=6379
TCP_AGENT_USERNAME=agent
TCP_AGENT_PASSWORD=agent_secret
TCP_AGENT_ALLOWED_ORIGINS=
TCP_AGENT_REQUIRE_TLS=false
TCP_AGENT_MAX_STREAMS_PER_AGENT=100

# Admin config API
ADMIN_SECRET=your_admin_secret_key
LOG_FORMAT=text
VERBOSE=false
```

`INSTALL_UUID` is optional -- a random UUID is generated on startup if not set.

### Docker

```bash
# Build and run
docker build -t tunnel-server .
docker run -d --restart=unless-stopped -p 7860:7860 \
  -e TUNNEL_USERNAME=admin \
  -e TUNNEL_PASSWORD=secret \
  tunnel-server
```

---

## Client Connection Guide (`client.js`)

The Client (e.g., on Google Colab or local machine) connects to the Server via the `setup.sh` script:

> The server accepts a **single** tunnel client at a time (`MAX_TUNNEL_CLIENTS` is fixed to 1); additional clients are rejected with close code `1013`.

**Requirements on the client machine:** `curl`, `node` (>= 18), `npm`, `mv` with GNU `-T` support

> On macOS: install coreutils (`brew install coreutils`) for `gmv -T`, then `alias mv=gmv`.

### 1. Automatic Installation via One-Line Command
```bash
curl -fsSL https://<your-server-host>/<uuid>-install | bash
```

### 2. Installation with Pre-set Environment Variables
```bash
TUNNEL_SERVER_URL=wss://your-server-host/tunnel \
TUNNEL_USERNAME=admin \
TUNNEL_PASSWORD=secret \
TARGET_ORIGIN=http://127.0.0.1:8000 \
curl -fsSL https://your-server-host/<uuid>-install | bash
```

Artifacts are downloaded into a unique immutable release directory and validated before the running client is stopped. A validation failure removes the new release and leaves the current client untouched. If a validated release fails readiness after activation, the installer reactivates and verifies the previous release.

### 3. Client Process Management
- **View Client Logs**: `tail -f ~/.tunnel-client/client.log`
- **Clear Client Logs**: `> ~/.tunnel-client/client.log`
- **Stop Client**: `kill $(cat ~/.tunnel-client/client.pid)`
- **Client Readiness**: The file `client.ready` in `~/.tunnel-client/` contains the client PID and confirms the client passed its startup readiness check.

---

## TCP Tunnel & TCP Agent

The server supports raw TCP tunneling (Redis, Postgres, MySQL, etc.) alongside HTTP, in two complementary modes that share the same binary frames (`TCP_OPEN`/`TCP_DATA`/`TCP_CLOSE`/`TCP_ABORT` + `PAUSE`/`RESUME`) and bidirectional backpressure.

### Direct mode (server opens TCP listeners)

The server listens on every port in `TCP_TUNNEL_PORTS`. For each inbound connection it asks the connected tunnel client to dial the **same port** on `TCP_TUNNEL_HOST` (usually `127.0.0.1`), then relays bytes in both directions.

```
External TCP Client -- TCP :6379 --> Server :6379 -- WS /tunnel --> client.js -- 127.0.0.1:6379 --> Redis
```

- Control access with `TCP_TUNNEL_BIND_HOST` and `TCP_TUNNEL_ALLOWED_IPS` (IPv4/CIDR allowlist).
- **No port remapping**: the local service must listen on the exact port the external app connects to.

### TCP agent mode (no inbound port on the server)

When the server runs on a PaaS/hosting platform with a single public port, run the standalone **TCP agent** (`dist/tcp-agent.js`) on the app host. It listens on `AGENT_PORTS` locally and relays connections over the server's `/tcp` WebSocket endpoint; the tunnel client on the service machine dials the local service.

```
Rails -- 127.0.0.1:6379 --> tcp-agent.js -- WS /tcp --> Server -- WS /tunnel --> client.js -- 127.0.0.1:6379 --> Redis
```

> **Agent mode**: the external app connects to the agent's local port on the app host (e.g. `redis://127.0.0.1:6379`), **not** to the server.

The `/tcp` endpoint only exists when `TCP_AGENT_ALLOWED_PORTS` is non-empty. It is protected by Basic Auth (defaults to the tunnel credentials, overridable with `TCP_AGENT_USERNAME`/`TCP_AGENT_PASSWORD`) and supports optional Origin allowlisting (`TCP_AGENT_ALLOWED_ORIGINS`) and TLS enforcement (`TCP_AGENT_REQUIRE_TLS`). The agent bundle is served at `/${INSTALL_UUID}-tcp-agent.js` with a minimal manifest at `/${INSTALL_UUID}-tcp-agent-package.json`.

Both modes can coexist on the same server. See [docs/tcp-tunnel.md](docs/tcp-tunnel.md) for the full configuration guide and Rails/Redis examples.

---

## Admin & Runtime Configuration (`/<uuid>-config`)

The Server allows real-time log configuration updates (`verbose`, `logFormat`) **without server restart** via HMAC Signed URLs.

- **Endpoint**: `GET` / `POST` `/<uuid>-config?expires=<TIMESTAMP>&sig=<HMAC_HEX>`
- **POST Body (JSON)**:
  ```json
  {
    "verbose": true,
    "logFormat": "json"
  }
  ```

---

## Health Checks

The server exposes two health check endpoints that always return `200 ok`:

- `GET /__health`
- `GET /healthz`

These do not require authentication. The Docker image includes a `HEALTHCHECK` directive that pings `/__health`.

---

## Graceful Shutdown

The server handles `SIGTERM` and `SIGINT` by:

1. Stopping TCP listeners and the TCP agent WebSocket endpoint (no new connections) and aborting active TCP streams, allowing up to 5 seconds to drain.
2. Closing all WebSocket clients (tunnel + agent) and the HTTP server (each WebSocket client is force-terminated after 5 seconds).
3. Exiting with code 0 (or 1 for `uncaughtException`).

The steps above run concurrently under a 10-second overall grace period, after which the process exits with code 1. Component errors during shutdown are isolated -- one failing component does not block the rest.

---

## Testing

The test suite uses the **Node.js built-in test runner** (`node:test`). No `--test-force-exit` flag is needed -- the suite exits cleanly after all tests complete.

```bash
npm test
```

See detailed testing instructions in [TESTING.md](TESTING.md).

Run `yarn test` for the current test count. Local real-service tests may skip when Redis/Postgres are unavailable; CI sets `REQUIRE_TCP_SERVICES=1`. TCP coverage includes unit tests for the agent server and virtual socket, a process-level agent test, and an end-to-end agent test.

---

## CI

Tests run automatically on Node.js 20, 22, and 24 with Redis and Postgres services available for integration tests.

---

## License

Licensed under the [MIT License](LICENSE).
