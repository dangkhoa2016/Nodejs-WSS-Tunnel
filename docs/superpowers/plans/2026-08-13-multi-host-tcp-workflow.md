# Multi-host TCP Workflow Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Publish and document a safe role-based setup workflow for one TCP service host and multiple application hosts.

**Architecture:** Add two standalone Bash installers under `scripts/`, backed by a focused static contract test. Add paired English/Vietnamese operational guides describing repeated agent installation, aggregate limits, shared transport credentials, and database-level identities.

**Tech Stack:** Bash, Markdown, Node.js built-in test runner, ESM.

## Global Constraints

- Public scripts contain no deployment hostname, UUID, or credential.
- All hosts use the same explicit `SERVER_HOST` and pinned `INSTALL_UUID`.
- Application agents bind `127.0.0.1` by default.
- Artifact downloads verify TLS and fallback manifests use `ws ^8.21.3`.
- Scripts support text and JSON readiness logs and validate PID ownership.
- Commit subjects are Conventional Commits of at most 72 characters with bullet-only bodies.

---

### Task 1: Publish script contract tests

**Files:**
- Create: `test/scripts/multi-host-setup.test.js`

**Interfaces:**
- Consumes: `scripts/setup-service-host.sh`, `scripts/setup-application-host.sh` as text.
- Produces: static security and configuration contract tests.

- [ ] Add assertions for explicit shared server identity, absent secrets, TLS verification, `ws ^8.21.3`, PID ownership, `/tunnel` versus `/tcp`, loopback binding, text/JSON readiness, and Redis-password non-disclosure.
- [ ] Run `node --test test/scripts/multi-host-setup.test.js` and confirm failure because public scripts do not exist.
- [ ] Commit the red test as `test(scripts): define multi-host setup contract`.

### Task 2: Add role-based setup scripts

**Files:**
- Create: `scripts/setup-service-host.sh`
- Create: `scripts/setup-application-host.sh`

**Interfaces:**
- Service host connects to `wss://$SERVER_HOST/tunnel` and dials loopback services.
- Application host connects to `wss://$SERVER_HOST/tcp` and exposes `AGENT_PORTS` on loopback.

- [ ] Implement validation, credential prompting, HTTPS artifact installation, dependency setup, safe process replacement, text/JSON readiness detection, and actionable output.
- [ ] Run the focused test and both `bash -n` commands; expect all to pass.
- [ ] Commit as `feat(scripts): add multi-host TCP setup`.

### Task 3: Add bilingual multi-host operations guides

**Files:**
- Create: `docs/guide-multi-host-tcp-services.md`
- Create: `docs/guide-multi-host-tcp-services.vi.md`
- Modify: `docs/guide-external-app-to-tcp-services.md`
- Modify: `docs/guide-external-app-to-tcp-services.vi.md`
- Modify: `test/docs/tcp-documentation.test.js`

**Interfaces:**
- Consumes: public script names and runtime limits from Task 2/current server.
- Produces: equivalent A/B/C deployment and revocation guidance.

- [ ] Add failing documentation assertions for both languages, multiple agents, aggregate `TCP_MAX_CONNECTIONS_PER_PORT`, per-agent `TCP_AGENT_MAX_STREAMS_PER_AGENT`, Redis ACL, and PostgreSQL roles.
- [ ] Write paired guides with server, A, B/C, verification, security, revocation, limits, and troubleshooting sections; link from existing guides.
- [ ] Run focused script/docs tests and commit as `docs(tcp): add multi-host operations guide`.

### Task 4: Verify repository and history

**Files:**
- Verify all changed files.

**Interfaces:**
- Consumes: Tasks 1–3.
- Produces: a clean, audited branch.

- [ ] Run focused tests, both shell syntax checks, `corepack yarn lint`, `node serve/build.js`, and `npm test`.
- [ ] Run `git diff --check` and audit the root plus root-to-HEAD history with `scripts/audit-commits.js`.
- [ ] Confirm every new commit stays below 1,000 lines of churn and the working tree is clean.

## Self-review

- All requirements in the approved spec map to Tasks 1–4.
- Script and document filenames are consistent across every task.
- No placeholders or deferred implementation steps remain.
