# Multi-host TCP Workflow Design

## Goal

Make the supported topology of one service host and multiple application hosts
discoverable, reproducible, and safe for every user who clones the repository.

## Public interface

The repository will provide two role-based scripts:

- `scripts/setup-service-host.sh` runs the `/tunnel` client on the machine that
  owns Redis, PostgreSQL, or other TCP services.
- `scripts/setup-application-host.sh` runs one `/tcp` agent on any machine that
  consumes those services. The same script serves Computer B, Computer C, and
  every additional application host.

The names describe responsibilities rather than a fixed number of computers.
The ignored files under `temp/` are not part of the public interface and are
not committed.

## Configuration contract

Every host receives the same explicit `SERVER_HOST` and pinned `INSTALL_UUID`.
`SERVER_HOST` is a hostname only, without scheme, path, or trailing slash. The
scripts do not contain deployment-specific hostnames, UUIDs, or credentials.

The service host requires `TUNNEL_USERNAME` and `TUNNEL_PASSWORD`. Application
hosts require `AGENT_USERNAME` and `AGENT_PASSWORD`, with the existing
`TUNNEL_USERNAME` and `TUNNEL_PASSWORD` fallback when the server does not use
dedicated agent credentials. Missing secrets are prompted from `/dev/tty`; no
published example credentials are silently selected.

The service host targets loopback by default and permits only that target host.
Application agents bind `127.0.0.1` by default and expose ports `6379,5432` only
when those ports are included in server `TCP_AGENT_ALLOWED_PORTS`.

## Multi-agent behavior and limits

One service-host tunnel client is sufficient, so `MAX_TUNNEL_CLIENTS=1` remains
appropriate. The server accepts multiple agent WebSockets; B and C each run
their own application-host script and each receive independent loopback
listeners.

`TCP_AGENT_MAX_STREAMS_PER_AGENT` applies independently to B and C.
`TCP_MAX_CONNECTIONS_PER_PORT` counts all active connections on a port across
all agents. Operators must size the global limit for aggregate traffic.

The current server has one agent credential pair, so B and C share transport
credentials unless the authentication model is extended later. Database access
must be separated with Redis ACL users and PostgreSQL roles when per-user
revocation or attribution is required.

## Installation and lifecycle safety

Artifact downloads use HTTPS with certificate verification. Served manifests
and fallback manifests use `ws ^8.21.3`. Existing valid bundles may be reused;
explicit refresh variables force a new download.

Before stopping a process, scripts validate that the PID is numeric, alive, and
has the expected `client.js` or `tcp-agent.js` command. Readiness and
authentication failures are recognized in both text and JSON log formats.
Redis test instructions use a placeholder `REDISCLI_AUTH` value and never print
the real password.

## Documentation

Add `docs/guide-multi-host-tcp-services.md` and
`docs/guide-multi-host-tcp-services.vi.md`. Both explain:

1. the A → server → B/C topology;
2. required server configuration;
3. service-host installation;
4. repeated application-host installation;
5. Redis and PostgreSQL connection checks;
6. global versus per-agent limits;
7. shared transport-credential limitations;
8. Redis ACL and PostgreSQL role separation;
9. adding and revoking an application host;
10. production and troubleshooting checks.

The existing external-service guides link to this multi-host guide rather than
duplicating all multi-user instructions.

## Tests and verification

Move the ignored static script test to `test/scripts/multi-host-setup.test.js`.
It validates explicit shared server identity, absence of embedded secrets,
certificate verification, dependency alignment, PID safety, correct WebSocket
paths, loopback binding, text/JSON readiness, and non-disclosure of database
passwords. Documentation tests verify both language variants mention multiple
agents, aggregate connection limits, and per-user database identities.

Verification consists of the focused tests, `bash -n` for both public scripts,
Biome lint, client build, the complete test suite, `git diff --check`, and the
repository commit-history auditor.

## Scope boundaries

This change documents and packages existing multi-agent behavior. It does not
add per-agent server credentials, modify the TCP protocol, expose agents beyond
loopback, or automatically configure Redis/PostgreSQL accounts.
