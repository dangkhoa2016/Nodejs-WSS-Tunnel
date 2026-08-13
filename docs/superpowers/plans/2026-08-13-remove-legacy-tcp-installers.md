# Remove Legacy TCP Installers Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Remove the duplicate installers from `docs/` and make the hardened role-named scripts the repository's only supported TCP host installers.

**Architecture:** Keep installation behavior exclusively in `scripts/setup-service-host.sh` and `scripts/setup-application-host.sh`. Documentation tests enforce that the supported scripts retain their safety and dependency properties while the legacy paths remain absent.

**Tech Stack:** Bash, Node.js built-in test runner, Git, Biome.

## Global Constraints

- Service hosts use `scripts/setup-service-host.sh`.
- Application hosts use `scripts/setup-application-host.sh`.
- Do not add a compatibility wrapper or another script download path.
- Preserve the canonical English and Vietnamese guide commands that pin an immutable release tag.

---

### Task 1: Enforce one installer per TCP host role

**Files:**
- Modify: `test/docs/tcp-documentation.test.js`
- Modify: `README.md`
- Delete: `docs/setup-tcp-agent.sh`
- Delete: `docs/setup-tunnel-client.sh`
- Test: `test/docs/tcp-documentation.test.js`
- Test: `test/scripts/multi-host-setup.test.js`

**Interfaces:**
- Consumes: the two shell entry points under `scripts/` and their documented environment-variable interface.
- Produces: one supported installer path per host role and a regression test that rejects the two removed paths.

- [ ] **Step 1: Write the failing absence and ownership assertions**

Update `test/docs/tcp-documentation.test.js` to import `existsSync` and load the supported scripts:

```js
import { existsSync, readFileSync } from 'node:fs';

const serviceHostSetup = read('scripts/setup-service-host.sh');
const applicationHostSetup = read('scripts/setup-application-host.sh');
```

Replace the assertion that reads `docs/setup-tcp-agent.sh` with assertions over
`applicationHostSetup`. Keep the served `ws` version comparison and require
`AGENT_BIND_HOST`. Assert that `serviceHostSetup` contains
`TCP_CLIENT_ALLOWED_HOSTS`, so both loaded scripts have an explicit ownership
check. Add this test:

```js
test('legacy TCP installer copies stay removed', () => {
  assert.equal(existsSync('docs/setup-tcp-agent.sh'), false);
  assert.equal(existsSync('docs/setup-tunnel-client.sh'), false);
});
```

- [ ] **Step 2: Run the focused test and verify RED**

Run:

```bash
node --test test/docs/tcp-documentation.test.js
```

Expected: FAIL only because both legacy files still exist.

- [ ] **Step 3: Remove the duplicate scripts and update the README tree**

Delete:

```text
docs/setup-tcp-agent.sh
docs/setup-tunnel-client.sh
```

In the README repository tree, remove both filenames from `docs/`. Add a
`scripts/` section that lists:

```text
scripts/setup-service-host.sh
scripts/setup-application-host.sh
```

Do not add wrapper scripts or replace the canonical guide commands.

- [ ] **Step 4: Verify GREEN and shell syntax**

Run:

```bash
node --test test/docs/tcp-documentation.test.js test/scripts/multi-host-setup.test.js
bash -n scripts/setup-service-host.sh
bash -n scripts/setup-application-host.sh
```

Expected: all tests pass and both syntax checks exit zero.

- [ ] **Step 5: Run repository verification**

Run:

```bash
yarn lint
node serve/build.js
npm test
git diff --check
```

Expected: lint and build exit zero; the complete test suite has zero failures; the diff has no whitespace errors.

- [ ] **Step 6: Commit the implementation**

```bash
git add README.md test/docs/tcp-documentation.test.js \
  docs/setup-tcp-agent.sh docs/setup-tunnel-client.sh
git commit -m "docs(tcp): remove superseded setup scripts" \
  -m "- Use the hardened role-named TCP host installers.\n- Prevent duplicate installer paths from being reintroduced."
node scripts/audit-commits.js --single HEAD
```

Expected: the commit succeeds and passes the history policy.
