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

## 4. How the installers work

Both installers use the same transactional model:

- **Staging before switchover.** The script downloads the bundle and the pinned
  `*-package.json` manifest, validates the bundle, and installs dependencies
  (`npm install --omit=dev`) into a unique directory under
  `~/.tunnel-client/releases/release.<random>` (or `~/.tcp-agent/releases/...`).
  The currently running process is only stopped after the new release is fully
  staged.
- **Atomic activation.** `current` is a symlink to the active release;
  `previous` points at the last known-good release used for rollback.
- **Readiness gate.** After activation the script waits for the
  `client.ready` / `agent.ready` file to contain the new PID. `agent.ready` is
  only written after the agent has **bound every `AGENT_PORTS` listener and
  opened its WebSocket to the server**, so a failure to bind a port is never
  reported as a successful install; it is invalidated (removed) whenever a
  listener fails to bind or closes unexpectedly or the WebSocket drops.
  `client.ready` is written once the client's authenticated WebSocket to
  `/tunnel` is open (the client binds no listeners) and is removed on
  disconnect, authentication failure, or shutdown. Ready files are written
  atomically (temp + rename) so a poller never reads partial content. If the
  process exits, times out, or logs an `auth_failed` (wrong credentials), the
  script kills the candidate, reactivates `previous` and re-verifies it,
  restoring the previous runtime configuration (credentials, ports, and service
  settings captured from the running process before it was stopped), then exits
  **nonzero** so an automation tool knows the new release did not land. If the
  previous runtime configuration cannot be captured (the old process is gone or
  its environment is unreadable), the script refuses to stop the running
  process unless `ALLOW_CODE_ONLY_ROLLBACK=1` is set, in which case it rolls
  back using the previous code with the current installer's runtime
  configuration (does not restore the previous process environment).
- **Old process safety.** A stale `client.pid`/`agent.pid` is only ever killed
  when it matches the expected process. An unrelated process is left alone and
  the install aborts.
- **Re-run to upgrade.** Running the same script again with the same
  `INSTALL_UUID` upgrades in place. A manifest change triggers a fresh
  dependency install for that release.
- **Logs.** Live output goes to `client.log`/`agent.log`; older logs rotate
  into `logs/`. A failed candidate keeps a `client.failed.*.log` (or
  `agent.failed.*.log`) for diagnostics.
- **Retention.** After a successful install the script prunes old releases
  (keeping `INSTALL_RELEASES_KEEP`, default 3) and rotated logs (keeping
  `SETUP_LOG_KEEP`, default 5). Both knobs must be integers with sane minimums,
  and pruning works even when the work directory contains spaces.
- **Concurrency guard.** A lock file makes a second concurrent installer exit
  immediately with `Another installation is already running`.
- **Legacy migration.** A pre-transactional install (bundle in the work
  directory root) is first archived as `releases/release.legacy.*` and used as
  the rollback target.

The application host additionally:

- requires `AGENT_PORTS` (no built-in default) and validates each port;
- defaults to binding `127.0.0.1` (or `::1`) and refuses a non-loopback bind
  unless `ALLOW_REMOTE_AGENT_BIND=1` is set explicitly;
- prints `redis-cli`/`psql` commands with the password redacted as
  `<redis-password>`/`<password>`.

## 5. Add Computer C and later hosts

Download the same pinned `setup-application-host.sh` version and repeat section
3 on C, D, and every consumer. All hosts use the same `SERVER_HOST` and
`INSTALL_UUID`. The current server exposes one agent transport credential pair,
so agents share it unless authentication is extended.

Applications use loopback URLs:

```text
redis://<redis-user>:<redis-password>@127.0.0.1:6379
postgresql://<postgres-role>:<password>@127.0.0.1:5432/<database>
```

## 6. Limits across multiple agents

- `TCP_AGENT_MAX_STREAMS_PER_AGENT` applies independently to each agent.
- `TCP_MAX_CONNECTIONS_PER_PORT` is aggregate across all agents for that port.
- Redis/PostgreSQL connection limits apply after tunnel limits. Size every
  layer from measured aggregate traffic.

## 7. Per-consumer authorization and revocation

Transport credentials cannot currently identify B separately from C. Create a
Redis ACL user and PostgreSQL role for each consumer, granting only required
commands, keys, schemas, tables, and operations.

To revoke B without interrupting C:

1. disable B's Redis ACL user and PostgreSQL role;
2. stop B's agent with `kill $(cat ~/.tcp-agent/agent.pid)` (verify the PID belongs to `tcp-agent.js` first);
3. remove `~/.tcp-agent` if B is decommissioned.

If the shared agent secret leaks, rotate it on the server and every authorized
agent. Per-agent transport-secret revocation is not supported yet.

## 8. Direct mode

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

## 9. Production checklist

- [ ] All hosts use the same hostname and pinned UUID.
- [ ] `/tunnel` and `/tcp` use WSS with a valid certificate.
- [ ] Agents keep `AGENT_BIND_HOST=127.0.0.1`.
- [ ] Redis/PostgreSQL retain authentication and per-consumer identities.
- [ ] Aggregate and per-agent limits cover expected concurrency.
- [ ] Credential rotation and database-user revocation are tested.

## 10. Troubleshooting

| Symptom | Check |
|---|---|
| B works but C fails | C hostname/UUID, agent credentials, and agent log |
| Agent receives 401 | Agent username and password |
| Agent receives 426 | WSS and trusted-proxy configuration |
| Connection limit reached | Aggregate per-port versus per-agent stream limit |
| Redis returns `NOAUTH` | Redis ACL identity and password |
| Redis returns `READONLY` | Use the writable Redis primary |
| PostgreSQL rejects login | PostgreSQL role, password, `pg_hba.conf`, grants |
