# TCP Tunnel Guide (Redis, Postgres, MySQL...)

> 🌐 Language / Ngôn ngữ: **English** | [Tiếng Việt](tcp-tunnel.vi.md)

This guide explains how to enable the **TCP tunnel** feature of Nodejs-WSS-Tunnel to expose TCP services (Redis, Postgres, MySQL...) running on the tunnel client side (Google Colab, Kaggle, a local PC) to the public Internet through the intermediary server — for example, so an external app such as **Rails** can connect to Redis through a regular Redis client.

---

## 1. Overview & Architecture

```
+------------------------+   TCP (plaintext)    +-----------------------------+
|  External TCP client   | ---------------------> |   Nodejs Tunnel Server      |
|  (Rails / redis-cli)   |   <server-host>:6379   |   (TcpRouter)               |
+------------------------+                        +--------------+--------------+
                                                                 |
                                                                 | WebSocket (binary frames)
                                                                 | Basic Auth
                                                                 v
                                                 +---------------+---------------+
                                                 |   Tunnel Client (Colab/Kaggle) |
                                                 |   (serve/client.js)            |
                                                 +---------------+---------------+
                                                                 |
                                                                 | TCP (local, 127.0.0.1)
                                                                 v
                                                 +---------------+---------------+
                                                 |   Local service on the client |
                                                 |   Redis at 127.0.0.1:6379     |
                                                 +---------------------------------+
```

This is a **reverse** tunnel:

1. The tunnel client **actively** connects to the server over WebSocket (so it works from restricted environments like Colab/Kaggle that cannot accept inbound connections).
2. The Node.js server listens on TCP ports configured via `TCP_TUNNEL_PORTS`.
3. When an external app (Rails) opens a TCP connection to `server-host:6379`, the server allocates a dedicated stream and sends a `TCP_OPEN` frame to the tunnel client over WebSocket.
4. The tunnel client opens a TCP connection to the local service (`TCP_TUNNEL_HOST:port`) — that is Redis — and relays data in both directions using `TCP_DATA`/`TCP_CLOSE`/`TCP_ABORT` frames.

### Important characteristics

- **Single client at a time**: the server accepts only **1** tunnel client (`MAX_TUNNEL_CLIENTS = 1`); extra clients are rejected with close code `1013`.
- **No port remapping**: the server sends `port: serverPort` in the `TCP_OPEN` frame (`src/TcpRouter.js:123`), and the client dials that same port on `TCP_TUNNEL_HOST`. This means the local service **must listen on the exact port** the external app connects to (e.g. Redis must be on `6379`; you cannot remap it to another port).
- **Bidirectional backpressure**: `PAUSE`/`RESUME` frames combined with WebSocket `bufferedAmount` and high/low water marks prevent memory leaks when one side is slower than the other.

### TCP frames in the protocol (`src/protocol.js`)

| Type | Value | Meaning |
|------|-------|---------|
| `TCP_OPEN` | `0x40` | Server asks the client to open a local TCP connection to `{ host, port }` |
| `TCP_DATA` | `0x41` | Bidirectional raw data payload |
| `TCP_CLOSE` | `0x42` | One side closed the connection |
| `TCP_ABORT` | `0x43` | Abort the stream with an error message |
| `TCP_CONNECT` | `0x50` | Agent asks the server to allocate a stream for a local port |
| `TCP_CONNECT_ACK` | `0x51` | Server acknowledges agent stream allocation |

---

## 2. Prerequisites

- The Node.js server can run `yarn dev` / `yarn prod` (Node.js >= 18).
- The machine running Redis (tunnel client) has **Node.js >= 18**, `curl`, and **Redis running**.
- The external app (Rails) has TCP connectivity to the Node.js server.

---

## 3. Server Configuration (Node.js)

All TCP environment variables are read in `src/config.js` and used in `src/TcpRouter.js`.

### 3.1 Environment variable reference

| Variable | Default | Description |
|----------|---------|-------------|
| `TCP_TUNNEL_PORTS` | *(empty)* | Comma-separated TCP ports to expose. **Empty = TCP tunnel disabled.** e.g. `6379,5432,3306` |
| `TCP_TUNNEL_HOST` | `127.0.0.1` | Host where the tunneled service resolves on the client machine (the host the client dials) |
| `TCP_TUNNEL_BIND_HOST` | `127.0.0.1` | Interface the server binds. Use `0.0.0.0` so external apps can connect over the network |
| `TCP_TUNNEL_ALLOWED_IPS` | *(empty = allow all)* | Comma-separated IP/CIDR allowlist for inbound TCP connections (IPv4). e.g. `127.0.0.1`, `10.0.0.0/8` |
| `TCP_CLIENT_ALLOWED_HOSTS` | `TCP_TUNNEL_HOST` | Hosts/IPs the tunnel client is allowed to connect to (enforced client-side) |
| `TCP_CONNECT_TIMEOUT_MS` | `10000` | Timeout for the client to establish the local TCP connection (ms) |
| `TCP_MAX_CONNECTIONS_PER_PORT` | `20` | Max concurrent TCP connections per tunneled port (`0` = unlimited) |
| `TCP_SHUTDOWN_DRAIN_TIMEOUT_MS` | `5000` | Timeout to drain active TCP streams during shutdown (ms) |

`TUNNEL_USERNAME` and `TUNNEL_PASSWORD` are also mandatory — the server exits with `[FATAL]` if they are missing.

### 3.2 Example `.env` for Redis + Rails

```env
# ===== Basic server =====
PORT=7860
TUNNEL_PATH=/tunnel
SERVER_HOST=https://your-server.example.com

# Required — tunnel WebSocket clients authenticate with these
TUNNEL_USERNAME=admin
TUNNEL_PASSWORD=your_strong_secret

# ===== TCP tunnel for Redis =====
# Redis port to expose
TCP_TUNNEL_PORTS=6379

# Redis host on the tunnel client machine (127.0.0.1 is standard)
TCP_TUNNEL_HOST=127.0.0.1

# Bind 0.0.0.0 so Rails can reach server-host:6379 from another machine
TCP_TUNNEL_BIND_HOST=0.0.0.0

# Only allow the Rails machine (or network) to connect to port 6379
TCP_TUNNEL_ALLOWED_IPS=203.0.113.10
# Or use CIDR: TCP_TUNNEL_ALLOWED_IPS=203.0.113.0/24

# The client may only dial the local Redis
TCP_CLIENT_ALLOWED_HOSTS=127.0.0.1

TCP_CONNECT_TIMEOUT_MS=10000
TCP_MAX_CONNECTIONS_PER_PORT=20
TCP_SHUTDOWN_DRAIN_TIMEOUT_MS=5000
```

> ⚠️ **Security warning**: if `TCP_TUNNEL_BIND_HOST=0.0.0.0` and `TCP_TUNNEL_ALLOWED_IPS` is empty, the server prints a `SECURITY WARNING` because Redis becomes reachable from anywhere. Always narrow `TCP_TUNNEL_ALLOWED_IPS`.
>
> ⚠️ **IP restriction**: the filter supports IPv4 only (`src/ipAllowlist.js`). IPv4-mapped addresses (`::ffff:127.0.0.1`) are normalized automatically, but native IPv6 (`::1`) will **not** match an allowlist entry.

Restart the server after editing:

```bash
yarn dev
```

Expected log output:

```text
[standard] [tcp] listen port=6379 bindHost=0.0.0.0 target=127.0.0.1
[server] TCP tunnel listening on 0.0.0.0:6379 -> client -> 127.0.0.1:6379
```

---

## 4. Tunnel Client Configuration (the machine running Redis)

There are two ways to run the client: via `setup.sh` (recommended, atomic upgrades) or directly with `node client.js`.

### 4.1 Client environment variables

| Variable | Required | Description |
|----------|----------|-------------|
| `TUNNEL_SERVER_URL` | ✅ | WebSocket URL of the server, e.g. `wss://your-server.example.com/tunnel` |
| `TUNNEL_USERNAME` / `TUNNEL_PASSWORD` | ✅ | Same values as on the server |
| `TCP_TUNNEL_HOST` | | Local service host the client dials (default `127.0.0.1`) |
| `TCP_CLIENT_ALLOWED_HOSTS` | | Hosts the client is allowed to dial (default `TCP_TUNNEL_HOST`) |
| `TCP_CONNECT_TIMEOUT_MS` | | Local dial timeout (default `10000`) |

`TARGET_ORIGIN` (default `http://127.0.0.1:8000`) is only used for the HTTP tunnel and does not affect TCP.

### 4.2 Run `node client.js` directly

```bash
TUNNEL_SERVER_URL=wss://your-server.example.com/tunnel \
TUNNEL_USERNAME=admin \
TUNNEL_PASSWORD=your_strong_secret \
TCP_TUNNEL_HOST=127.0.0.1 \
TCP_CLIENT_ALLOWED_HOSTS=127.0.0.1 \
node serve/client.js
```

> `serve/client.js` loads `dotenv` automatically when `NODE_ENV=development`, so you can put these values in a `.env` file in the directory where you run the command.

### 4.3 Install via `setup.sh`

```bash
TUNNEL_SERVER_URL=wss://your-server.example.com/tunnel \
TUNNEL_USERNAME=admin \
TUNNEL_PASSWORD=your_strong_secret \
curl -fsSL https://your-server.example.com/<install-uuid>-install | bash
```

`setup.sh` (see `serve/setup.sh`):

- Downloads the `client.js` bundle from `https://<server>/<INSTALL_UUID>-client.js`, validates it with `node --check`, then activates it atomically (symlink `~/.tunnel-client/current`).
- Creates a `.env` file in the release directory with `TUNNEL_SERVER_URL`, `TUNNEL_USERNAME`, `TUNNEL_PASSWORD`, `TARGET_ORIGIN`.
- Starts the client in the background and waits for the `client.ready` file (containing the PID) as a readiness signal. Rolls back to the previous release on failure.

Managing the client:

```bash
tail -f ~/.tunnel-client/client.log     # follow logs
kill $(cat ~/.tunnel-client/client.pid) # stop the client
```

> `setup.sh` does not write the TCP variables (`TCP_TUNNEL_HOST`...) into `.env`; if you need non-default values, run the client per section 4.2 or add the variables to the `.env` inside the release directory and restart it.

---

## 5. TCP Agent (PaaS / hosting)

The modes above assume the tunnel client runs on the same machine as the service (Redis). When the server is hosted on a PaaS platform with a **single public port** and the service is on a **different** machine, the server cannot open `TCP_TUNNEL_PORTS` directly. In that case run the **TCP agent**: a standalone process installed on the app host that listens on a local port and relays connections over the same WebSocket protocol, while the tunnel client on the service machine dials the local service.

```
Rails ── localhost:6379 ──> tcp-agent.js ── WS /tcp ──> Server :7860 ── WS /tunnel ──> client.js ── 127.0.0.1:6379 ──> Redis
```

> **Agent mode:** the server does not open a TCP listener for the agent. The
> external app connects to the agent's local port on the app host. For the
> Rails example, the Redis URL becomes `redis://127.0.0.1:6379` — not
> `redis://your-server.example.com:6379`.

### 5.1 When to use

- The server is on a PaaS/hosting platform (Render, Railway, Fly.io...) that exposes only one public port, so the server cannot bind `TCP_TUNNEL_PORTS`.
- The app host can run a small Node.js process (Node.js >= 18) and has `curl` plus `npm` (or `yarn`/`pnpm`).
- The local service binds `127.0.0.1` on the app host.

### 5.2 Install the agent on the app host

Download the prebuilt bundle and install its single dependency:

```bash
curl -fL https://your-server.example.com/<INSTALL_UUID>-tcp-agent.js -o tcp-agent.js
npm i ws
```

Or install via the manifest (gives you a `package.json` with the right dependency):

```bash
curl -fsSL https://your-server.example.com/<INSTALL_UUID>-tcp-agent-package.json -o package.json
npm i
```

> `<INSTALL_UUID>` is the server's `INSTALL_UUID` value (set it in the server's
> `.env` so it stays stable across restarts). Automated setup scripts that fetch
> `/tcp-agent.js` must switch to the prefixed URL; the standalone agent setup can
> point `AGENT_BUNDLE_URL` at `https://your-server.example.com/<INSTALL_UUID>-tcp-agent.js`.

### 5.3 Agent environment variables

| Variable | Required | Description |
|----------|----------|-------------|
| `TUNNEL_SERVER_URL` | ✅ | WebSocket URL of the server **with the agent path**, e.g. `wss://your-server.example.com/tcp` |
| `TUNNEL_USERNAME` / `TUNNEL_PASSWORD` | ✅ | Same values as on the server (Basic Auth) |
| `AGENT_BIND_HOST` | | Interface the agent listens on for local TCP connections (default `127.0.0.1`) |
| `AGENT_PORTS` | ✅ | Comma-separated local ports the agent exposes, e.g. `6379` |
| `AGENT_USERNAME` / `AGENT_PASSWORD` | | Agent WS credentials; fall back to `TUNNEL_USERNAME` / `TUNNEL_PASSWORD` when unset |

> The agent exits with an error if `TUNNEL_SERVER_URL`, credentials
> (`AGENT_USERNAME`/`AGENT_PASSWORD` or `TUNNEL_USERNAME`/`TUNNEL_PASSWORD`),
> or `AGENT_PORTS` are missing.

```bash
TUNNEL_SERVER_URL=wss://your-server.example.com/tcp \
TUNNEL_USERNAME=admin \
TUNNEL_PASSWORD=your_strong_secret \
AGENT_BIND_HOST=127.0.0.1 \
AGENT_PORTS=6379 \
node tcp-agent.js
```

### 5.4 Server configuration

Enable the agent endpoint and the ports an agent may open:

| Variable | Default | Description |
|----------|---------|-------------|
| `TCP_AGENT_PATH` | `/tcp` | WS path the TCP agent connects to |
| `TCP_AGENT_ALLOWED_PORTS` | *(empty)* | Comma-separated ports agents are allowed to open (**empty = agent endpoint disabled**) |
| `TCP_AGENT_USERNAME` | `TUNNEL_USERNAME` | Agent WS credentials; falls back to the tunnel credentials when unset |
| `TCP_AGENT_PASSWORD` | `TUNNEL_PASSWORD` | Agent WS credentials; falls back to the tunnel credentials when unset |
| `TCP_AGENT_ALLOWED_ORIGINS` | empty | Comma-separated Origin allowlist; an Origin header not in the list is rejected (403), no Origin header is allowed |
| `TCP_AGENT_REQUIRE_TLS` | `false` | Require `req.socket.encrypted` or `X-Forwarded-Proto: https` for `/tcp` upgrades (426 otherwise) |
| `TCP_AGENT_MAX_STREAMS_PER_AGENT` | `100` | Max concurrent streams per agent (`0` = unlimited) |

Minimal example:

```env
TCP_AGENT_ALLOWED_PORTS=6379
TCP_AGENT_PATH=/tcp
```

### 5.5 Security notes

- Keep `AGENT_BIND_HOST=127.0.0.1` — the agent listener must never be public.
- The agent WebSocket uses Basic Auth: the tunnel credentials (`TUNNEL_USERNAME`/`TUNNEL_PASSWORD`) by default, overridable per side with `TCP_AGENT_USERNAME`/`TCP_AGENT_PASSWORD` (server) and `AGENT_USERNAME`/`AGENT_PASSWORD` (agent).
- Use `wss://` (TLS) on public networks — the TCP tunnel is plaintext.
- An empty `TCP_AGENT_ALLOWED_PORTS` disables the agent endpoint entirely.
- `TCP_AGENT_REQUIRE_TLS` trusts the `X-Forwarded-Proto` header, so only enable it behind a TLS-terminating reverse proxy that sanitizes/overwrites that header.

### 5.6 Manual check

```bash
redis-cli -h 127.0.0.1 -p 6379 ping
# PONG
```

Direct mode (`TCP_TUNNEL_PORTS` on the tunnel client) remains the standard choice for VPS deployments; both modes can coexist on the same server.

---

## 6. Redis Configuration on the Tunnel Client Machine

Redis can run anywhere as long as the tunnel client can dial it. The default Redis configuration is usually sufficient:

```conf
# redis.conf (defaults usually fine)
bind 127.0.0.1
protected-mode yes

# Recommended for an extra layer of security
requirepass your_redis_password
```

> Since the client dials `127.0.0.1:6379`, Redis only needs to bind `127.0.0.1`. Do not bind `0.0.0.0` on the client machine unless you have a reason — local Redis should not be exposed to the network.

Quick check on the client machine:

```bash
redis-cli -h 127.0.0.1 -p 6379 ping
# PONG
```

---

## 7. External App Configuration (Rails example)

The key point: the external app connects to the **Node.js server** (not the Redis machine), on the exact port listed in `TCP_TUNNEL_PORTS`.

### 7.1 Rails cache / Redis client

`config/cache_store.rb`:

```ruby
config.cache_store = :redis_cache_store, {
  url: "redis://your-server.example.com:6379",
  # if Redis has requirepass:
  # url: "redis://:your_redis_password@your-server.example.com:6379",
  connect_timeout: 5,
  read_timeout: 5,
  write_timeout: 5
}
```

`config/redis.yml` (used by Sidekiq, Redis Objects...):

```yaml
production:
  url: redis://your-server.example.com:6379
  # if requirepass is set:
  # url: redis://:your_redis_password@your-server.example.com:6379
```

Sidekiq in `config/sidekiq.yml`:

```yaml
:concurrency: 5
:redis:
  url: redis://your-server.example.com:6379
```

### 7.2 Other clients

```bash
# Direct redis-cli
redis-cli -h your-server.example.com -p 6379 ping

# Python
pip install redis
python -c "import redis; print(redis.Redis(host='your-server.example.com', port=6379).ping())"

# Node.js
npm install redis
node -e "const r=require('redis').createClient({url:'redis://your-server.example.com:6379'}); r.connect().then(()=>r.ping()).then(console.log)"
```

---

## 8. Verification

**Step 1 — is the server TCP tunnel running?**

```text
[standard] [tcp] listen port=6379 ...
[server] TCP tunnel listening on 0.0.0.0:6379 -> client -> 127.0.0.1:6379
```

If you see `[standard] [tcp] skip reason=TCP_TUNNEL_PORTS not configured`, then `TCP_TUNNEL_PORTS` is empty.

**Step 2 — is the tunnel client connected?**

```text
[client] Connected to tunnel server
```

Check the server health endpoint too:

```bash
curl -s https://your-server.example.com/__health
# 200 ok
```

**Step 3 — from the external app machine, test the TCP connection:**

```bash
redis-cli -h your-server.example.com -p 6379 ping
# PONG  ->  tunnel works end-to-end
```

**Step 4 — verbose logging** (server): set `VERBOSE=true` in `.env` to see per-stream details:

```text
[verbose] tcp connection streamId=... serverPort=6379 remoteAddr=...
[verbose] stream tcp_allocate streamId=... serverPort=6379
```

On the client side, verbose logging records the local dial:

```text
[verbose] tcp open streamId=... host=127.0.0.1 port=6379
[verbose] tcp local_connected streamId=... host=127.0.0.1 port=6379
```

---

## 9. Troubleshooting

| Symptom | Cause / Fix |
|---------|-------------|
| `[FATAL] TUNNEL_USERNAME and TUNNEL_PASSWORD must be set.` | Missing credentials on the server. Set `TUNNEL_USERNAME`/`TUNNEL_PASSWORD` in `.env`. |
| `[standard] [tcp] skip reason=TCP_TUNNEL_PORTS not configured` | `TCP_TUNNEL_PORTS` is empty. Fill in the ports to tunnel, e.g. `6379`. |
| Server prints `SECURITY WARNING: TCP_TUNNEL_BIND_HOST=0.0.0.0 with no TCP_TUNNEL_ALLOWED_IPS set` | Binding `0.0.0.0` with an empty allowlist — Redis is exposed to the whole network. Narrow `TCP_TUNNEL_ALLOWED_IPS`. |
| `[standard] tcp reject reason=ip_not_allowed` | The external app's IP is not in `TCP_TUNNEL_ALLOWED_IPS`. Add the matching IP/CIDR. |
| `[standard] tcp reject reason=no_client` | No tunnel client is connected over WebSocket yet. Run `client.js`/`setup.sh` on the Redis machine. |
| `[standard] tcp reject reason=per_port_limit` | Over `TCP_MAX_CONNECTIONS_PER_PORT` (default 20). Increase it or set `0` (unlimited). |
| `[client] Connection closed: 1013` | A second client was rejected because the server accepts only 1 tunnel client. |
| `[client] Authentication failed. Check username/password.` | Wrong `TUNNEL_USERNAME`/`TUNNEL_PASSWORD` on the client. |
| Client logs `TCP connect timeout` / `connect ECONNREFUSED` | The client cannot dial `TCP_TUNNEL_HOST:port`. Verify Redis is running on port `6379`, and `TCP_CLIENT_ALLOWED_HOSTS` includes that host. |
| Client logs `Host ... not allowed` | `TCP_CLIENT_ALLOWED_HOSTS` does not include the host the client is dialing. |
| Rails times out / `Connection reset` under load | Check `TCP_MAX_CONNECTIONS_PER_PORT`, `MAX_CONCURRENT_STREAMS`, and consider raising `WS_HIGH_WATER_BYTES`. |
| `redis-cli -h <server> -p 6379 ping` hangs | The server is not bound to the right interface (`TCP_TUNNEL_BIND_HOST`), or a firewall blocks port 6379 to the server. |

---

## 10. Security Best Practices

1. **Use `wss://`** for the WebSocket (TLS), never `ws://`, across the Internet — the TCP tunnel is plaintext.
2. **Always narrow `TCP_TUNNEL_ALLOWED_IPS`** to the external app's IP/CIDR when binding `0.0.0.0`.
3. **Set `requirepass`** on Redis for a second layer of security.
4. **Use strong `TUNNEL_USERNAME`/`TUNNEL_PASSWORD`** — they protect the entire tunnel (HTTP + TCP).
5. **Do not bind `0.0.0.0` for Redis on the client machine** — the client dials `127.0.0.1`, which is enough.
6. **Do not expose admin endpoints**: `/__health` and `/healthz` are public; other endpoints (install/config) require their respective URL/keys.
7. **Monitor both server and client logs** (`~/.tunnel-client/client.log`) to detect unexpected connections from `remoteAddr`.
8. **Run the server behind a TLS reverse proxy** (nginx/caddy) if TLS is not already provided.
