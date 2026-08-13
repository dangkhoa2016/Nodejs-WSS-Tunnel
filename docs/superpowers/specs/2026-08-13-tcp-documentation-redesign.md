# TCP Documentation Redesign

## Goal

Restructure the TCP tunnel documentation so a new operator can reach a working
deployment quickly and an experienced operator can safely harden, observe, and
troubleshoot that deployment in production.

## Audience and progression

The documentation serves both first-time users and production operators. Each
guide starts with prerequisites, a mode-selection decision, and copy-pasteable
quick-start commands. Advanced configuration, security boundaries, operations,
and troubleshooting follow after the first successful connection.

## Documentation structure

`docs/tcp-tunnel.md` and `docs/tcp-tunnel.vi.md` remain the authoritative
technical references. Their sections cover architecture, direct and agent
modes, installation, complete configuration, authentication and trust
boundaries, connection limits, health checks, production readiness,
troubleshooting, and implementation references.

`docs/guide-external-app-to-tcp-services.md` and its Vietnamese counterpart
remain task-oriented deployment guides. They explain mode selection, Redis and
PostgreSQL deployment, mode-specific connectivity checks, application
configuration, security, and symptom-specific diagnosis.

Existing filenames and language-switch links remain stable. English and
Vietnamese documents carry equivalent commands, configuration keys, warnings,
and section ordering.

## Required corrections

- Environment variables for piped installers must reach the `bash` process.
- Manifest-based agent installation must fetch both `package.json` and the
  executable `tcp-agent.js` bundle.
- Direct mode must use the configured TCP service port without claiming native
  TLS or automatic port remapping.
- Agent TLS enforcement must document `TCP_AGENT_TRUSTED_PROXIES`: forwarded
  protocol headers are trusted only from an explicitly trusted immediate peer;
  directly encrypted sockets remain valid.
- `TCP_TUNNEL_PORTS` must be identified as server configuration.
- Redis `READONLY` diagnosis must be separated from connection saturation and
  timeout diagnosis.
- Source links must match the current `src/tcp` and `src/shared` layout.
- Setup scripts must document `AGENT_BIND_HOST` and use the same `ws` dependency
  range as the served agent manifest.
- Port `7860` must be described as an example value of configurable `PORT`, not
  an invariant of every deployment.

## Safety and production guidance

Direct mode documentation must state that the raw TCP listener is unencrypted
unless the operator supplies a separate TCP TLS proxy, and must recommend
firewalling and `TCP_TUNNEL_ALLOWED_IPS`. Agent mode must keep
`AGENT_BIND_HOST=127.0.0.1`, require WSS in production, explain reverse-proxy
trust, and avoid exposing credentials in repository files.

## Automated safeguards

A focused Node test reads the documentation and setup script as data. It checks
the corrected installer shape, current source paths, trusted-proxy coverage,
direct-mode semantics, complete manifest installation, dependency consistency,
and critical English/Vietnamese parity. The test should validate durable facts
without snapshotting prose or preventing future editorial improvements.

## Verification

Run the focused documentation test first, then the default test suite, lint,
client build, shell syntax checks for both setup scripts, Markdown link checks
available in the repository, and `git diff --check`.
