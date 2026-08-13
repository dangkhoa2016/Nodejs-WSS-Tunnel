# Share TCP Services with Multiple Application Hosts

> Language: **English** | [Tiếng Việt](guide-multi-host-tcp-services.vi.md)

This guide connects Redis and PostgreSQL on one service host (Computer A) to
two or more application hosts (Computers B, C, ...). It uses agent mode, so the
tunnel server needs only its HTTP/WebSocket port.

## Topology

```text
Computer B ── 127.0.0.1:6379/5432 ── agent ─┐
Computer C ── 127.0.0.1:6379/5432 ── agent ─┼─ WSS /tcp ─ server
                                             └─ WSS /tunnel ─ Computer A
                                                                ├─ Redis 6379
                                                                └─ PostgreSQL 5432
```

Computer A runs exactly one tunnel client. Every application host runs its own
agent and gets independent loopback listeners. B and C may use the same local
port numbers because they are different machines.

## 1. Configure the tunnel server

Use a stable hostname and pin `INSTALL_UUID`:

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

`MAX_TUNNEL_CLIENTS=1` is sufficient because only A connects to `/tunnel`.
The server accepts multiple `/tcp` agents. If a reverse proxy terminates TLS,
also configure `TCP_AGENT_TRUSTED_PROXIES` with only the immediate proxy IP or
CIDR; otherwise forwarded protocol headers are ignored.

Build the served bundles before production startup:

```bash
node serve/build.js
npm run prod
```

## 2. Set up Computer A (service host)

Redis and PostgreSQL should listen on loopback. Download or clone the repository,
then run:

```bash
export SERVER_HOST='tunnel.example.com'
export INSTALL_UUID='<stable-uuid>'
export TUNNEL_USERNAME='<tunnel-user>'
export TUNNEL_PASSWORD='<long-tunnel-secret>'

./scripts/setup-service-host.sh
```

Verify the client:

```bash
tail -f ~/.tunnel-client/client.log
```

Do not run another tunnel client on B or C. The single client on A can dial both
ports because the server requests the exact allowed port on `127.0.0.1`.

## 3. Set up Computer B

```bash
export SERVER_HOST='tunnel.example.com'
export INSTALL_UUID='<stable-uuid>'
export AGENT_USERNAME='<agent-user>'
export AGENT_PASSWORD='<long-agent-secret>'
export AGENT_PORTS='6379,5432'

./scripts/setup-application-host.sh
```

Applications on B connect only to loopback:

```text
redis://<redis-user>:<redis-password>@127.0.0.1:6379
postgresql://<postgres-role>:<password>@127.0.0.1:5432/<database>
```

## 4. Set up Computer C and additional hosts

Run the same `scripts/setup-application-host.sh` command on C, D, and each
additional consumer. Use the same server hostname and UUID. The current server
has one transport credential pair, so all agents use the same
`AGENT_USERNAME`/`AGENT_PASSWORD` unless the server authentication model is
extended.

Verify on every application host:

```bash
REDISCLI_AUTH='<redis-password>' redis-cli --user '<redis-user>' -h 127.0.0.1 -p 6379 ping
PGPASSWORD='<password>' psql -h 127.0.0.1 -p 5432 -U '<postgres-role>' -d '<database>' -c 'SELECT 1'
```

## 5. Understand limits

- `TCP_AGENT_MAX_STREAMS_PER_AGENT` is independent for each agent. With `100`,
  B may have 100 active streams and C may separately have 100.
- `TCP_MAX_CONNECTIONS_PER_PORT` is aggregate across all agents. With `40`, B
  and C together may have at most 40 active connections to Redis and separately
  40 to PostgreSQL.
- Database connection limits still apply after the tunnel limits. Size all
  three layers from observed workload; do not use unlimited values by default.

## 6. Separate user identity and permissions

B and C currently share transport credentials, so transport authentication
cannot identify or revoke one application host independently. Separate access
at the database layer:

- Create one Redis ACL user for B and another Redis ACL user for C. Grant only
  the commands and key patterns each application needs.
- Create a separate PostgreSQL role for B and C. Grant only required databases,
  schemas, tables, and operations.

This provides attribution and per-user revocation even though the agents share
the server's transport credential.

## 7. Add or revoke an application host

To add a host, create its database identities and run the application-host
script there. To revoke B without interrupting C:

1. disable or delete B's Redis ACL user and PostgreSQL role;
2. stop B's agent with `kill $(cat ~/.tcp-agent/agent.pid)`;
3. remove `~/.tcp-agent` from B if the machine is decommissioned.

If the agent transport credential is exposed, rotate
`TCP_AGENT_USERNAME`/`TCP_AGENT_PASSWORD` on the server and restart every
authorized agent. The current implementation cannot rotate only B's transport
credential.

## 8. Production checklist

- [ ] A, B, and C use the same `SERVER_HOST` and pinned `INSTALL_UUID`.
- [ ] `/tunnel` and `/tcp` use WSS with a valid certificate.
- [ ] Every agent retains `AGENT_BIND_HOST=127.0.0.1`.
- [ ] Redis and PostgreSQL retain authentication and per-host identities.
- [ ] Aggregate and per-agent limits cover expected concurrency.
- [ ] Logs and health endpoints are monitored.
- [ ] Credential rotation and database-user revocation are tested.

## 9. Troubleshooting

| Symptom | Check |
|---|---|
| B connects but C does not | C uses the same hostname/UUID; agent credentials; C agent log |
| Agent receives 401 | `TCP_AGENT_USERNAME` and `TCP_AGENT_PASSWORD` |
| Agent receives 426 | WSS and `TCP_AGENT_TRUSTED_PROXIES` at TLS termination |
| Connection says limit reached | Aggregate per-port limit versus per-agent stream limit |
| Redis returns `NOAUTH` | Redis ACL username and password |
| Redis returns `READONLY` | Redis topology; use a writable primary |
| PostgreSQL rejects login | Role password, `pg_hba.conf`, database grants |
