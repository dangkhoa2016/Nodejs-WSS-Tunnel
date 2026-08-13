# Consolidate External TCP Service Guides

## Goal

Remove duplicated operational instructions while preserving every published
documentation path and both supported languages.

## Canonical documents

`docs/guide-external-app-to-tcp-services.md` and
`docs/guide-external-app-to-tcp-services.vi.md` become the only canonical,
maintained guides for connecting external applications to TCP services.

Each canonical guide uses the same section order:

1. choose direct mode or agent mode;
2. understand one service host with one or many application hosts;
3. configure the tunnel server;
4. install the service-host script without a source checkout;
5. install the application-host script on B, C, and later hosts;
6. configure Redis/PostgreSQL clients;
7. understand aggregate and per-agent limits;
8. separate database identities and revoke one consumer;
9. use direct mode when the server can safely expose raw TCP;
10. apply production security and troubleshoot failures.

The English and Vietnamese versions contain equivalent commands, warnings,
configuration names, and operational decisions.

## Compatibility redirects

The existing multi-host paths remain in Git to avoid broken inbound links:

- `docs/guide-multi-host-tcp-services.md`
- `docs/guide-multi-host-tcp-services.vi.md`

Each becomes a short language-specific relocation page linking directly to its
canonical counterpart. Redirect pages contain no setup commands or copied
configuration, so future runtime changes require editing only the canonical
pair.

## Installation model

Service and application hosts do not clone the repository. They download only
the appropriate role script from a trusted immutable release tag or receive
that single file from the administrator. Production instructions do not use a
moving `main` branch.

The canonical guides retain these facts:

- A runs one `scripts/setup-service-host.sh` client.
- B, C, and later consumers each run `scripts/setup-application-host.sh`.
- `TCP_AGENT_MAX_STREAMS_PER_AGENT` applies independently per agent.
- `TCP_MAX_CONNECTIONS_PER_PORT` is aggregate across all agents for a port.
- Agents currently share one transport credential pair.
- Redis ACL users and PostgreSQL roles provide per-consumer authorization and
  revocation.

## Tests

Documentation tests treat only the external-app pair as canonical content.
They verify single and multi-host setup, pinned one-script installation, limit
scope, database identities, and language navigation. Separate assertions check
that both legacy multi-host files are short and point to the correct canonical
language file without retaining setup commands.

## Scope

This is a documentation consolidation only. It does not change scripts,
runtime behavior, authentication, protocol frames, or old design/plan records
under `docs/superpowers`.
