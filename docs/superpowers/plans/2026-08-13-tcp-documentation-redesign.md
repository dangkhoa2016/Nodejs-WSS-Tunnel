# TCP Documentation Redesign Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the TCP documentation with a balanced quick-start and production-operations guide whose commands and configuration match the current runtime.

**Architecture:** Preserve the four public Markdown filenames and their language links, but reorganize each English/Vietnamese pair around the same mode-selection and deployment flow. Add one focused Node test that treats docs and installer manifests as data, protecting operational invariants without snapshotting editorial prose.

**Tech Stack:** Markdown, Bash, Node.js built-in test runner, ESM, Biome.

## Global Constraints

- Preserve existing public documentation filenames and relative language links.
- Keep English and Vietnamese commands, configuration keys, warnings, and section order equivalent.
- Direct mode has no port remapping and no native TLS listener.
- `X-Forwarded-Proto` is trusted only when the immediate peer matches `TCP_AGENT_TRUSTED_PROXIES`.
- Keep the agent listener on `127.0.0.1` by default.
- Use Conventional Commit subjects of at most 72 characters and bullet-only commit bodies.
- Keep each implementation commit below 1,000 changed lines.

---

### Task 1: Add executable documentation invariants

**Files:**
- Create: `test/docs/tcp-documentation.test.js`
- Read: `docs/tcp-tunnel.md`
- Read: `docs/tcp-tunnel.vi.md`
- Read: `docs/guide-external-app-to-tcp-services.md`
- Read: `docs/guide-external-app-to-tcp-services.vi.md`
- Read: `docs/setup-tcp-agent.sh`
- Read: `serve/tcp-agent-package.json`

**Interfaces:**
- Consumes: repository-relative Markdown, Bash, and JSON files.
- Produces: a standalone Node test runnable with `node --test test/docs/tcp-documentation.test.js`.

- [ ] **Step 1: Write the failing documentation test**

Create an ESM test that loads files with `readFileSync(new URL(..., import.meta.url), 'utf8')`. Add focused assertions that both language variants:

```js
assert.match(reference, /TCP_AGENT_TRUSTED_PROXIES/);
assert.doesNotMatch(reference, /src\/(TcpRouter|protocol|config|ipAllowlist)\.js/);
assert.match(reference, /tcp-agent\.js/);
assert.match(reference, /tcp-agent-package\.json/);
assert.doesNotMatch(guide, /-p 443[^\n]*--tls/);
```

Parse `serve/tcp-agent-package.json`, extract `dependencies.ws`, and assert the fallback JSON in `docs/setup-tcp-agent.sh` contains the same range. Assert the setup script's documented override list contains `AGENT_BIND_HOST`.

- [ ] **Step 2: Run the focused test and confirm red state**

Run: `node --test test/docs/tcp-documentation.test.js`

Expected: FAIL for the currently stale source paths, missing trusted-proxy documentation, invalid direct-mode TLS example, incomplete manifest instructions, and missing override documentation.

- [ ] **Step 3: Commit the red test**

```bash
git add test/docs/tcp-documentation.test.js
git commit -m "test(docs): define TCP documentation invariants" \
  -m "- Guard deployment commands, trust boundaries, and source references.\n- Keep installer dependency guidance aligned with the served manifest."
```

### Task 2: Rewrite the authoritative TCP reference pair

**Files:**
- Modify: `docs/tcp-tunnel.md`
- Modify: `docs/tcp-tunnel.vi.md`

**Interfaces:**
- Consumes: runtime configuration in `src/shared/config.js`, request security in `src/HttpRouter.js`, and artifact routes exposed by the server.
- Produces: equivalent English and Vietnamese technical references.

- [ ] **Step 1: Reorganize both references in lockstep**

Use this section sequence in both files: purpose and prerequisites; choose a mode; architecture; direct-mode quick start; agent-mode quick start; tunnel-client installation; agent installation; configuration reference; security and trust boundaries; limits/backpressure; health and logs; production checklist; troubleshooting; protocol/source references.

- [ ] **Step 2: Correct every operational example**

Use exported variables or bind variables to the right-hand `bash` process:

```bash
curl -fsSL "https://$SERVER_HOST/$INSTALL_UUID-install" |
  TUNNEL_SERVER_URL="wss://$SERVER_HOST/tunnel" \
  TUNNEL_USERNAME="$TUNNEL_USERNAME" \
  TUNNEL_PASSWORD="$TUNNEL_PASSWORD" \
  TARGET_ORIGIN="http://127.0.0.1:8000" bash
```

In the manual agent installation, download both artifacts before `npm install` and `node tcp-agent.js`:

```bash
curl -fsSLO "https://$SERVER_HOST/$INSTALL_UUID-tcp-agent.js"
curl -fsSL "https://$SERVER_HOST/$INSTALL_UUID-tcp-agent-package.json" -o package.json
npm install --omit=dev
```

Document `TCP_AGENT_TRUSTED_PROXIES` with default empty, IPv4/CIDR syntax, immediate-peer semantics, and an example for a known reverse proxy. State that direct encrypted sockets satisfy TLS enforcement without forwarded headers.

- [ ] **Step 3: Correct ownership and source paths**

Identify `TCP_TUNNEL_PORTS` as server-side configuration. Link implementation references to `src/tcp/TcpRouter.js`, `src/shared/protocol.js`, `src/shared/config.js`, and `src/shared/ipAllowlist.js`.

- [ ] **Step 4: Run the focused test**

Run: `node --test test/docs/tcp-documentation.test.js`

Expected: failures remain only for the task-oriented guides or setup dependency alignment.

- [ ] **Step 5: Commit the reference rewrite**

```bash
git add docs/tcp-tunnel.md docs/tcp-tunnel.vi.md
git commit -m "docs(tcp): rewrite deployment reference" \
  -m "- Balance working quick starts with production configuration.\n- Correct installer, TLS trust, port ownership, and source guidance."
```

### Task 3: Rewrite the external-application guide pair

**Files:**
- Modify: `docs/guide-external-app-to-tcp-services.md`
- Modify: `docs/guide-external-app-to-tcp-services.vi.md`

**Interfaces:**
- Consumes: direct-mode and agent-mode semantics established by Task 2.
- Produces: scenario-driven Redis/PostgreSQL deployment guides in both languages.

- [ ] **Step 1: Rebuild the guides around mode selection**

Use this section sequence: outcome; prerequisites; choose direct or agent mode; server configuration; service-host client setup; external-app agent setup; mode-specific verification; application connection strings; production hardening; troubleshooting; final checklist.

- [ ] **Step 2: Fix connectivity examples and warnings**

For direct Redis mode use the exact configured port and no TLS claim:

```bash
redis-cli -h <server-host> -p 6379 -a '<redis-password>' ping
```

Warn that this socket is raw TCP unless a separate TCP TLS proxy is configured, and require a firewall plus `TCP_TUNNEL_ALLOWED_IPS`. For agent mode, test only `127.0.0.1:6379` on the agent host. Describe `PORT=7860` as the example WebSocket/HTTP port, not a fixed public-port invariant.

- [ ] **Step 3: Split troubleshooting by cause**

Explain that Redis `READONLY` means the connection reached a replica or read-only instance; direct operators should inspect Redis topology and writable-primary selection. Keep timeout/saturation advice in a separate row covering `TCP_MAX_CONNECTIONS_PER_PORT`, `TCP_AGENT_MAX_STREAMS_PER_AGENT`, firewalls, and logs.

- [ ] **Step 4: Run the focused test**

Run: `node --test test/docs/tcp-documentation.test.js`

Expected: only setup-script or manifest alignment assertions may still fail.

- [ ] **Step 5: Commit the scenario guides**

```bash
git add docs/guide-external-app-to-tcp-services.md docs/guide-external-app-to-tcp-services.vi.md
git commit -m "docs(tcp): rewrite external service guide" \
  -m "- Separate direct and agent deployment verification.\n- Correct raw TCP, configurable port, and Redis diagnostics."
```

### Task 4: Align setup artifacts and finish verification

**Files:**
- Modify: `docs/setup-tcp-agent.sh`
- Modify: `serve/tcp-agent-package.json`
- Modify: `serve/client-package.json`
- Test: `test/docs/tcp-documentation.test.js`

**Interfaces:**
- Consumes: root `package.json` dependency range `^8.21.3`.
- Produces: served manifests and fallback installer JSON using the same `ws` range, plus documented bind-host override.

- [ ] **Step 1: Align dependency ranges and override documentation**

Set `dependencies.ws` to `^8.21.3` in both served manifests and in the fallback JSON emitted by `docs/setup-tcp-agent.sh`. Add this line to the optional override block:

```bash
#   AGENT_BIND_HOST    listen address (default 127.0.0.1; keep loopback in production)
```

- [ ] **Step 2: Run focused and syntax tests**

Run:

```bash
node --test test/docs/tcp-documentation.test.js
bash -n docs/setup-tcp-agent.sh
bash -n docs/setup-tunnel-client.sh
```

Expected: all commands exit 0.

- [ ] **Step 3: Run full project verification**

Run:

```bash
corepack yarn lint
node serve/build.js
npm test
git diff --check
```

Expected: lint and build succeed; test suite has zero failures, with only documented infrastructure-dependent skips; whitespace check is empty.

- [ ] **Step 4: Audit the resulting commits**

Run:

```bash
ROOT=$(git rev-list --max-parents=0 HEAD)
node scripts/audit-commits.js --single "$ROOT"
node scripts/audit-commits.js --base "$ROOT" --head HEAD
```

Expected: zero subject, body, chronology, or churn violations; every implementation commit remains below 1,000 changed lines.

- [ ] **Step 5: Commit artifact alignment**

```bash
git add docs/setup-tcp-agent.sh serve/tcp-agent-package.json serve/client-package.json
git commit -m "chore(tcp): align agent setup dependencies" \
  -m "- Use the current ws range in served and fallback manifests.\n- Document the loopback bind-host override."
```

## Self-review

- Spec coverage: every required correction, bilingual pairing, security warning, and verification command maps to Tasks 1–4.
- Placeholder scan: the plan contains no deferred implementation markers.
- Interface consistency: the focused test path and dependency source are identical in all tasks; direct and agent semantics remain consistent across both guide pairs.
