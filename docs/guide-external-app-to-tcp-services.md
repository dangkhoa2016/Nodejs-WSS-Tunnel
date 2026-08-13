# Connect External Applications to TCP Services

> Language: **English** | [Tiếng Việt](guide-external-app-to-tcp-services.vi.md)

Use this guide to share Redis, PostgreSQL, or another TCP service from one
service host (Computer A) with one or many application hosts (B, C, ...).

## Choose direct or agent mode

| Requirement | Direct mode | Agent mode |
|---|---|---|
| Application connects to | Public server TCP port | Agent loopback port |
| Extra public TCP port | Required | Not required |
| Recommended for | Controlled VPS/network | PaaS and multiple remote hosts |
| External transport | Raw TCP | Local TCP, then WSS |

Direct mode is simpler when the server can expose and firewall the exact
service port. Agent mode is safer for PaaS and lets every B/C host receive its
own `127.0.0.1` listeners through the server's existing WebSocket port.

## Architecture

```text
Computer B ── 127.0.0.1:6379/5432 ── agent ─┐
Computer C ── 127.0.0.1:6379/5432 ── agent ─┼─ WSS /tcp ─ server
                                             └─ WSS /tunnel ─ Computer A
                                                                ├─ Redis 6379
                                                                └─ PostgreSQL 5432
```

A runs one tunnel client. Each application host runs an independent agent. B
and C can use the same local ports because they are different machines.

## 1. Configure the server for agent mode

```env
INSTALL_UUID=<stable-uuid>
TUNNEL_USERNAME=<tunnel-user>
TUNNEL_PASSWORD=<long-tunnel-secret>
MAX_TUNNEL_CLIENTS=1

TCP_AGENT_ALLOWED_PORTS=6379,5432
TCP_AGENT_USERNAME=<agent-user>
TCP_AGENT_PASSWORD=<long-agent-secret>
TCP_AGENT_REQUIRE_TLS=true
TCP_AGENT_MAX_STREAMS_PER_AGENT=100
TCP_MAX_CONNECTIONS_PER_PORT=40
```

`MAX_TUNNEL_CLIENTS=1` is enough because only A connects to `/tunnel`. The
server accepts multiple `/tcp` agents. Behind a TLS-terminating proxy, configure
`TCP_AGENT_TRUSTED_PROXIES` with only the immediate proxy IP/CIDR.

Build bundles before production startup:

```bash
node serve/build.js
npm run prod
```

## 2. Install Computer A (service host)

No source checkout is required. Download only the script from a trusted,
immutable release tag (or receive that file from the administrator):

```bash
curl -fsSL 'https://raw.githubusercontent.com/dangkhoa2016/Nodejs-WSS-Tunnel/<release-tag>/scripts/setup-service-host.sh' -o setup-service-host.sh
chmod 750 setup-service-host.sh

export SERVER_HOST='tunnel.example.com'
export INSTALL_UUID='<stable-uuid>'
export TUNNEL_USERNAME='<tunnel-user>'
export TUNNEL_PASSWORD='<long-tunnel-secret>'
./setup-service-host.sh
```

Keep Redis and PostgreSQL on loopback. Replace `<release-tag>` with an approved
immutable version; do not install production scripts from a moving `main`.

## 3. Install Computer B (application host)

```bash
curl -fsSL 'https://raw.githubusercontent.com/dangkhoa2016/Nodejs-WSS-Tunnel/<release-tag>/scripts/setup-application-host.sh' -o setup-application-host.sh
chmod 750 setup-application-host.sh

export SERVER_HOST='tunnel.example.com'
export INSTALL_UUID='<stable-uuid>'
export AGENT_USERNAME='<agent-user>'
export AGENT_PASSWORD='<long-agent-secret>'
export AGENT_PORTS='6379,5432'
./setup-application-host.sh
```

Verify both services locally:

```bash
REDISCLI_AUTH='<redis-password>' redis-cli --user '<redis-user>' -h 127.0.0.1 -p 6379 ping
PGPASSWORD='<password>' psql -h 127.0.0.1 -p 5432 -U '<postgres-role>' -d '<database>' -c 'SELECT 1'
```

## 4. Add Computer C and later hosts

Download the same pinned `setup-application-host.sh` version and repeat section
3 on C, D, and every consumer. All hosts use the same `SERVER_HOST` and
`INSTALL_UUID`. The current server exposes one agent transport credential pair,
so agents share it unless authentication is extended.

Applications use loopback URLs:

```text
redis://<redis-user>:<redis-password>@127.0.0.1:6379
postgresql://<postgres-role>:<password>@127.0.0.1:5432/<database>
```

## 5. Limits across multiple agents

- `TCP_AGENT_MAX_STREAMS_PER_AGENT` applies independently to each agent.
- `TCP_MAX_CONNECTIONS_PER_PORT` is aggregate across all agents for that port.
- Redis/PostgreSQL connection limits apply after tunnel limits. Size every
  layer from measured aggregate traffic.

## 6. Per-consumer authorization and revocation

Transport credentials cannot currently identify B separately from C. Create a
Redis ACL user and PostgreSQL role for each consumer, granting only required
commands, keys, schemas, tables, and operations.

To revoke B without interrupting C:

1. disable B's Redis ACL user and PostgreSQL role;
2. stop B's agent with `kill $(cat ~/.tcp-agent/agent.pid)`;
3. remove `~/.tcp-agent` if B is decommissioned.

If the shared agent secret leaks, rotate it on the server and every authorized
agent. Per-agent transport-secret revocation is not supported yet.

## 7. Direct mode

Use direct mode only when the platform forwards the exact TCP port:

```env
TCP_TUNNEL_PORTS=6379,5432
TCP_TUNNEL_BIND_HOST=0.0.0.0
TCP_TUNNEL_ALLOWED_IPS=203.0.113.10,198.51.100.20
```

Verify Redis from an allowed address:

```bash
REDISCLI_AUTH='<redis-password>' redis-cli -h <server-host> -p 6379 ping
```

Direct listeners are raw TCP unless you deploy a separate TCP TLS proxy. Always
restrict them with a firewall and `TCP_TUNNEL_ALLOWED_IPS`. There is no port
remapping: the service on A must listen on the same requested port.

## 8. Production checklist

- [ ] All hosts use the same hostname and pinned UUID.
- [ ] `/tunnel` and `/tcp` use WSS with a valid certificate.
- [ ] Agents keep `AGENT_BIND_HOST=127.0.0.1`.
- [ ] Redis/PostgreSQL retain authentication and per-consumer identities.
- [ ] Aggregate and per-agent limits cover expected concurrency.
- [ ] Credential rotation and database-user revocation are tested.

## 9. Troubleshooting

| Symptom | Check |
|---|---|
| B works but C fails | C hostname/UUID, agent credentials, and agent log |
| Agent receives 401 | Agent username and password |
| Agent receives 426 | WSS and trusted-proxy configuration |
| Connection limit reached | Aggregate per-port versus per-agent stream limit |
| Redis returns `NOAUTH` | Redis ACL identity and password |
| Redis returns `READONLY` | Use the writable Redis primary |
| PostgreSQL rejects login | PostgreSQL role, password, `pg_hba.conf`, grants |
