# Guide: Connecting an External App to TCP Services (Redis) through the Tunnel

> 🌐 Language / Ngôn ngữ: **English** | [Tiếng Việt](guide-external-app-to-tcp-services.vi.md)

> Use this guide when an app on one machine must reach a local service (e.g.
> Redis) that runs on another machine behind the Nodejs-WSS-Tunnel server.
> A typical setup: Redis runs on your home/server machine; your deployed app
> (Rails, Sidekiq, Python, Node...) on a different machine must talk to it.

## 1. Overview and topology

The tunnel has three moving parts:

- **Tunnel client** (`docs/setup-tunnel-client.sh`) — runs on the machine that
  hosts the service (Redis). It dials the server over WebSocket `/tunnel`.
- **Server** (`Nodejs-WSS-Tunnel`) — relays streams between the client and
  agents. Exposes exactly one public port (7860).
- **TCP agent** (`docs/setup-tcp-agent.sh`) — runs on the external/app-host
  machine. It listens on a local port and bridges to the server over WebSocket
  `/tcp`.

```
External machine (app / redis-cli)
        |  TCP (local)   redis://127.0.0.1:6379
        v
   tcp-agent.js  -- WS /tcp -->  Server :7860  -- WS /tunnel -->  client.js
   (runs on external box)           (github.dev)               (Redis box)
                                                                      |
                                                                TCP (local)
                                                                      v
                                                          Redis 127.0.0.1:6379
```

The app just connects to `redis://127.0.0.1:6379` on the external machine. No
port needs to be opened on the server.

## 2. Terminology

| Term | What it is | Runs on |
|---|---|---|
| Tunnel client | WebSocket `/tunnel` endpoint that dials local services | The machine with the service (Redis) |
| Server | Relay hub (`Nodejs-WSS-Tunnel`) | Public host |
| TCP agent | WebSocket `/tcp` endpoint that exposes a local port | External / app machine |

## 3. Prerequisites

- Both machines: Node.js >= 18 and `curl`.
- External machine additionally: `npm`.
- Server credentials: `TUNNEL_USERNAME` / `TUNNEL_PASSWORD` by default. If the server administrator configured custom `TCP_AGENT_USERNAME` / `TCP_AGENT_PASSWORD` values, use those for the TCP agent.

### 3.1 Where to get the real values

| Value | Source |
|---|---|
| `<server-host>` | Your tunnel server administrator |
| `<server-install-uuid>` | Server log line `Install UUID: ...`; pin it in the server `.env` (`INSTALL_UUID=...`) so artifact URLs stay stable |
| `<server-tunnel-username>` / `<server-tunnel-password>` | Server `TUNNEL_USERNAME` / `TUNNEL_PASSWORD` |
| `<agent-username>` / `<agent-password>` | Server `TCP_AGENT_USERNAME` / `TCP_AGENT_PASSWORD` (falls back to `TUNNEL_USERNAME` / `TUNNEL_PASSWORD` when unset) |
| `<redis-password>` | `requirepass` of the Redis running on the tunnel-client machine |

> If `INSTALL_UUID` is not set in the server `.env`, the server generates a new
> UUID on every restart, which changes every artifact URL.

## 4. Part 1 — Machine that hosts the service (Redis)

On the machine that runs Redis:

1. Copy `docs/setup-tunnel-client.sh` there.
2. Fill in the CONFIG block: `SERVER_HOST`, `INSTALL_UUID`, `TUNNEL_USERNAME`,
   `TUNNEL_PASSWORD`. `TARGET_ORIGIN` is the HTTP tunnel target (unused by the
   TCP/Redis path).
3. Run `bash setup-tunnel-client.sh`.

Verify:

```bash
tail -f ~/.tunnel-client/client.log
# look for: "Connected to tunnel server"
```

The client installs itself into `~/.tunnel-client/`. Stop it with
`kill $(cat ~/.tunnel-client/client.pid)`.

## 5. Part 2 — External / app-host machine

On the external machine:

1. Copy `docs/setup-tcp-agent.sh` there.
2. Fill in the CONFIG block: `SERVER_HOST`, `INSTALL_UUID`, `REDIS_PASSWORD`.
   Agent credentials are prompted unless you set `AGENT_USERNAME` /
   `AGENT_PASSWORD` (or `TUNNEL_USERNAME` / `TUNNEL_PASSWORD`) first.
3. Run `bash setup-tcp-agent.sh`.

On success the script prints `Agent connected to tunnel server.` and the agent
listens on `127.0.0.1:6379`. Verify:

```bash
redis-cli -h 127.0.0.1 -p 6379 -a <redis-password> ping
# PONG
```

Logs: `$HOME/.redis-agent/agent.log`. Stop: `kill $(cat $HOME/.redis-agent/agent.pid)`.

## 6. App configuration

Full URL (with password):

```
redis://:<redis-password>@127.0.0.1:6379
```

**Rails** — `config/cache_store.rb`:

```ruby
config.cache_store = :redis_cache_store, {
  url: "redis://:<redis-password>@127.0.0.1:6379",
  connect_timeout: 5,
  read_timeout: 5,
  write_timeout: 5
}
```

**Sidekiq** — `config/sidekiq.yml`:

```yaml
:concurrency: 5
:redis:
  url: redis://:<redis-password>@127.0.0.1:6379
```

**Python:**

```python
import redis
r = redis.Redis(host="127.0.0.1", port=6379, password="<redis-password>")
print(r.ping())  # True
```

**Node.js:**

```js
const redis = require('redis');
const client = redis.createClient({ url: 'redis://:<redis-password>@127.0.0.1:6379' });
await client.connect();
console.log(await client.ping()); // PONG
```

## 7. Direct mode (when the server exposes a TCP port)

This works only if BOTH hold:

1. The server binds TCP on the network: `TCP_TUNNEL_BIND_HOST=0.0.0.0`
   (it currently defaults to `127.0.0.1`).
2. The hosting platform forwards that TCP port publicly (github.dev does not
   currently forward a second port).

Only then can the app connect straight to the server edge:

```bash
redis-cli -h <server-host> -p 443 -a <redis-password> --tls ping
# PONG
```

Otherwise prefer **Part 2** (the TCP agent).

## 8. Troubleshooting

| Symptom | Cause / Fix |
|---|---|
| Agent log `Authentication failed` / server log `agent_ws_reject reason=invalid_credentials` | Wrong credentials. By default the agent uses `TUNNEL_USERNAME` / `TUNNEL_PASSWORD`. If the server sets `TCP_AGENT_USERNAME` / `TCP_AGENT_PASSWORD`, ensure you provide those matching agent credentials (section 3). |
| Server log `tcp reject reason=no_client` | No tunnel client is connected over `/tunnel`. Run Part 1 on the Redis machine; check `tail -f ~/.tunnel-client/client.log` for `Connected to tunnel server`. |
| `redis-cli ping` says `NOAUTH` | Missing password: add `-a <redis-password>`. |
| `connect ECONNREFUSED` on `127.0.0.1:6379` | The agent is not running. Re-run Part 2. |
| Redis says `READONLY` / times out under load | Check `TCP_MAX_CONNECTIONS_PER_PORT` (server, default 20) and `TCP_AGENT_MAX_STREAMS_PER_AGENT` (default 100). |

## 9. Security notes

- Always use `wss://` (TLS). The tunnel carries plaintext TCP between the
  client and the agent through the server.
- Keep `AGENT_BIND_HOST=127.0.0.1` — do not expose the agent to the network.
- Keep a strong Redis `requirepass`; never share it publicly.
- Only one tunnel client may connect to `/tunnel` at a time (server accepts a
  single client).
