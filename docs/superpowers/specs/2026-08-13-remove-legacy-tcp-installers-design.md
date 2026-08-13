# Remove Legacy TCP Installers

## Goal

Keep one supported installer for each TCP host role and remove the older copies
from `docs/` before they drift further from the hardened implementations.

## Supported interface

- Service hosts use `scripts/setup-service-host.sh`.
- Application hosts use `scripts/setup-application-host.sh`.
- The canonical English and Vietnamese TCP guides continue to download these
  scripts from an immutable release tag.

## Repository changes

- Delete `docs/setup-tunnel-client.sh` and `docs/setup-tcp-agent.sh`.
- Update the README tree so it lists the supported scripts under `scripts/` and
  no longer advertises the deleted copies.
- Move documentation assertions that still inspect the old agent installer to
  the two supported installers.
- Add an assertion that the legacy installer paths remain absent, preventing a
  second source of truth from being reintroduced accidentally.

## Compatibility

The deleted scripts are not used by the canonical guides. No compatibility
wrapper will be added: a wrapper would need to select or download a release and
would recreate an installation path that the project does not intend to
support. Existing users should migrate to the role-named scripts above.

## Verification

- Demonstrate the new absence assertion fails before deleting the legacy files.
- Run the focused documentation and installer tests after the deletion.
- Run shell syntax checks, lint, build, the full test suite, and commit-history
  policy validation before completion.
