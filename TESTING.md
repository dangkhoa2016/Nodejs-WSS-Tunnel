# Test Suite Guide

> 🌐 Language / Ngôn ngữ: **English** | [Tiếng Việt](TESTING.vi.md)

This document provides detailed instructions on running, understanding the structure, and writing tests (unit & integration tests) for the **`Nodejs WSS Tunnel`** project.

---

## 📊 Test Suite Status

The test suite is built on **Node.js built-in Test Runner (`node:test`)**, with no dependency on third-party testing frameworks (such as Jest or Mocha).

- Run `yarn test` for the current test count. Local real-service tests may skip when Redis/Postgres are unavailable; CI sets `REQUIRE_TCP_SERVICES=1`.

---

## 🚀 Running Tests

### 1. Run Full Test Suite
Use the standard command configured in `package.json`:

```bash
npm test
```

Or run directly via Node.js test runner:

```bash
node --test test/*.test.js
```

### 2. Run Individual Test Files

- **Config Endpoint & Health Check Integration Tests**:
  ```bash
  node --test test/config-endpoint.test.js
  ```

- **Utility Functions & HMAC Encoding Tests**:
  ```bash
  node --test test/utils.test.js
  ```

- **Logger System & Dynamic Config Patching Tests**:
  ```bash
  node --test test/logger.test.js
  ```

- **StreamManager Unit Tests**:
  ```bash
  node --test test/stream-manager.test.js
  ```

- **StreamManager TCP Lifecycle Tests**:
  ```bash
  node --test test/stream-manager-tcp.test.js
  ```

- **TCP Client Handler Tests**:
  ```bash
  node --test test/tcp-client-handler.test.js
  ```

- **TCP Router Tests**:
  ```bash
  node --test test/tcp-router.test.js
  ```

- **TCP Flow Control Tests**:
  ```bash
  node --test test/tcp-flow-control.test.js
  ```

- **Graceful Shutdown Tests**:
  ```bash
  node --test test/shutdown.test.js
  ```

- **Installer Unit Tests**:
  ```bash
  node --test test/installer.test.js
  ```

- **Installer End-to-End Tests** (builds real client bundle, requires `yarn build:client`):
  ```bash
  node --test test/installer-e2e.test.js
  ```

- **TCP End-to-End Tests**:
  ```bash
  node --test test/tcp-e2e.test.js
  ```

- **TCP Cleanup Tests**:
  ```bash
  node --test test/tcp-cleanup.test.js
  ```

- **TCP Real Integration Tests**:
  ```bash
  node --test test/tcp-real-integration.test.js
  ```

- **TCP Stress Tests**:
  ```bash
  node --test test/tcp-stress.test.js
  ```

- **IP Allowlist Tests**:
  ```bash
  node --test test/ip-allowlist.test.js
  ```

---

## 📁 Test File Structure (`test/`)

### 1. `test/config-endpoint.test.js` (Integration Tests)
Integration tests for the HTTP Server and admin configuration endpoint:
- **Automatically spawns HTTP Server** on a random port (`findFreePort()`).
- **HMAC Signature Validation (`/${serverUuid}-config`)**:
  - Rejects access without signature (returns 404).
  - Rejects expired signatures (Expired expiration timestamp).
  - Rejects tampered signatures (Tampered HMAC hex).
  - Rejects wrong secret key.
- **GET Request**: Returns current `verbose` and `logFormat` configuration.
- **POST Request**: Dynamically updates `verbose` (`true`/`false`) and `logFormat` (`text`/`json`) configuration. Validates input data types.
- **Method Not Allowed**: Ensures HTTP 405 is returned for `PUT`, `DELETE`.
- **Health Check**: Ensures `/__health` and `/healthz` always return `200 ok`.

### 2. `test/utils.test.js` (Unit Tests)
Unit tests for utility functions in `src/utils.js`:
- `generateSignedUrl()`: Ensures SHA256 hex signature is 64 characters and expiration timestamp is accurate.
- `validateHmacSignature()`: Validates HMAC signature verification accuracy, including edge cases (missing parameters, non-numeric timestamp, wrong hex length, expired signature).
- `roundtrip`: Tests that signature generation and validation are 100% compatible.

### 3. `test/logger.test.js` (Unit Tests)
Unit tests for the logging system in `src/logger.js`:
- `getConfig()` / `setConfig()`: Dynamically updates configuration properties without affecting object isolation.
- `logStandard()`: Tests log output for valid categories (`ws`, `http`, `proxy`, `stream`, `heartbeat`, `auth`) and ignores invalid categories.
- `logVerbose()`: Ensures verbose logging only works when `serverConfig.verbose = true`.

### 4. `test/stream-manager.test.js` (Unit Tests)
Unit tests for the stream manager in `src/StreamManager.js`:
- `allocateStreamId()`: Returns incrementing stream IDs starting from 1.
- `createStream()`:
  - Stores `meta` on the returned state object (critical for logging `method`/`url` in `HttpRouter`).
  - Stores all required state properties (`id`, `ws`, `req`, `res`, `cleaned`, `abortSent`, etc.).
  - Registers the stream in the internal `streams` map.
  - Returns `null` and sends 503 when `ws.send` fails (tunnel client unavailable).
- `cleanupStream()`: Removes stream from map and is idempotent (safe to call multiple times).
- `abortStream()`:
  - Sends `REQ_ABORT` frame to client when `notifyClient=true`.
  - Does not send `REQ_ABORT` when `notifyClient=false`.
  - Writes 502 JSON response when response has not started.
  - Does not send duplicate `REQ_ABORT` frames.
  - Does nothing if stream is already cleaned.
- `handleClientFrame()`: Ignores frames for unknown stream IDs and frames from wrong WebSocket connections.

### 5. `test/stream-manager-tcp.test.js` (Unit Tests)
Unit tests for TCP stream lifecycle in `src/StreamManager.js`:
- `createTcpStream()`: Stores state with `mode: 'tcp'`, registers in streams map.
- `cleanupTcpStream()`: Removes TCP stream, destroys socket, calls `onCleanup` callback, idempotent.
- `abortTcpStream()`: Sends `TCP_ABORT` to client when `notifyClient=true`, otherwise silent cleanup.
- `getTcpStreams()`: Returns only TCP streams (not HTTP streams).
- `handleClientFrame` TCP cases: `TCP_DATA` writes to socket, `TCP_CLOSE` cleans up, `PAUSE`/`RESUME` control `peerPausedForWrite`.

### 6. `test/tcp-client-handler.test.js` (Unit Tests)
Unit tests for `src/TcpClientHandler.js`:
- Frame routing: `TCP_OPEN`, `TCP_DATA`, `TCP_CLOSE`, `TCP_ABORT`, `PAUSE`, `RESUME` all return `true`.
- Unknown frame types return `false` (fall through to HTTP handler).
- Host validation: `TCP_OPEN` with disallowed host sends `TCP_ABORT`.
- `cleanupTcpStreams()`: Cleans up all TCP streams, leaves HTTP streams intact.

### 7. `test/tcp-router.test.js` (Unit Tests)
Unit tests for `src/TcpRouter.js`:
- Start with empty `TCP_TUNNEL_PORTS` skips listening (no error).
- `_handleConnection` rejects when no active WS client.
- Per-port connection count tracking.

### 8. `test/tcp-e2e.test.js` (End-to-End Test)
Full integration test: real TCP server -> WS tunnel -> TcpClientHandler -> local TCP server:
- Verifies `TCP_OPEN` creates a `net.connect()` to the target.
- Verifies `TCP_DATA` flows from server through WS to local TCP socket.
- Verifies echo response flows back as `TCP_DATA` frames to the server.
- Verifies `TCP_CLOSE` cleanup.

### 9. `test/tcp-cleanup.test.js` (Unit Tests)
Unit tests for WS disconnect TCP cleanup:
- Cleans up all TCP streams when WebSocket disconnects.
- Handles rapid open/close cycles without resource leaks.

### 10. `test/tcp-real-integration.test.js` (Integration Tests)
Real infrastructure integration tests (requires running Redis/Postgres):
- Redis PING/PONG through TCP tunnel.
- Redis SET/GET/DEL operations through TCP tunnel.
- Postgres TCP connect through tunnel.
- 5 parallel concurrent Redis PINGs.

### 11. `test/tcp-stress.test.js` (Stress Tests)
Stress and performance tests:
- 50 concurrent Redis PINGs through tunnel.
- Rapid open/close cycle stress test.

### 12. `test/ip-allowlist.test.js` (Unit Tests)
Unit tests for `src/ipAllowlist.js`:
- Empty allowlist allows all IPs.
- Exact IP matching, `/32`, `/24`, `/16`, `/0` CIDR matching.
- IPv4-mapped IPv6 prefix stripping.
- Multiple allowlist entries, invalid CIDR handling.

### 13. `test/tcp-flow-control.test.js` (Unit Tests)
Unit tests for TCP flow control coordination in `src/TcpFlowControl.js`:
- `syncSocketReadState()` coordinates `peerPausedRead` and `localPausedForWs` to decide actual socket pause/resume.
- Pausing at WS level while peer is already paused keeps socket paused.
- Resuming at WS level when peer is still paused keeps socket paused.

### 14. `test/shutdown.test.js` (Integration Tests)
Integration tests for graceful shutdown in `src/index.js`:
- `close()` returns a single shared promise for concurrent callers.
- HTTP server stops accepting new connections.
- Existing WebSocket connections are drained with a 5s timeout.
- Cleanup does not hang beyond the timeout.

### 15. `test/installer.test.js` (Unit Tests)
Unit tests for `serve/setup.sh` installer script:
- **Invalid bundle cleanup**: Bundles that fail `node --check` are cleaned up.
- **Stale readiness rejection**: If `client.ready` exists before the client starts, the installer rejects with a clear error.
- **Success path**: A valid client binary is downloaded, started, and the `pid` file is written.

### 16. `test/installer-e2e.test.js` (End-to-End Test)
Full E2E test that builds a real `dist/client.js` bundle, runs the tunnel server, and tests the installer workflow:
- **First install**: Downloads the bundle, starts the client, verifies PID is alive.
- **Upgrade install**: Runs installer again with the same work directory; verifies PID changes and `previous` symlink is created.
- **Rollback**: Installs a broken client bundle and verifies the installer rolls back to the previous release and continues serving tunneled HTTP requests.

---

### Enforcing Required Services in CI
Tests that exercise real Redis/Postgres connections (`tcp-real-integration.test.js`, `tcp-stress.test.js`) auto-skip when those services are unavailable. Set `REQUIRE_TCP_SERVICES=1` to make them fail (instead of skip) — useful in CI:
```bash
REQUIRE_TCP_SERVICES=1 node --test test/tcp-real-integration.test.js test/tcp-stress.test.js
```

## 💡 Technical Notes for Writing & Running Tests

1. **Test Environment Isolation (`NODE_ENV=test`)**:
   When running tests, `src/config.js` skips loading the local `.env` file to avoid overwriting the fixed port `7860`, allowing the Server in `config-endpoint.test.js` to listen on a random port allocated by the test runner.
2. **No Top-Level `process.exit()`**:
   All environment variable validation logic is encapsulated within the `validateConfig()` function (only called when `TunnelServer.start()` is executed), preventing unit test imports from being abruptly terminated.
3. **Scoping `before()` / `after()` Hooks**:
   In Node.js Test Runner, the `before()` and `after()` hooks that initialize the Server must be wrapped within a shared `describe(...)` block to ensure initialization completes before child tests run.
4. **`VERBOSE` Environment Variable**:
   Set `VERBOSE=true` in `.env` to enable verbose logging at startup. This controls `logVerbose()` output. The `/admin/config` API endpoint can also toggle it at runtime.
