# Consolidate TCP Guides Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Maintain one bilingual TCP operations guide while preserving old multi-host URLs as redirects.

**Architecture:** Move all multi-agent material into the external-service English/Vietnamese pair. Replace the former multi-host pair with command-free relocation pages and enforce this boundary in documentation tests.

**Tech Stack:** Markdown, Node.js built-in test runner, Biome.

## Global Constraints

- Preserve all four published filenames.
- Canonical instructions live only in `guide-external-app-to-tcp-services.*`.
- Redirect files contain no shell commands or environment configuration.
- English and Vietnamese canonical guides remain operationally equivalent.
- Host scripts are downloaded from an immutable release tag without cloning.

---

### Task 1: Define canonical and redirect contracts

**Files:**
- Modify: `test/docs/tcp-documentation.test.js`

- [ ] Make canonical assertions read the external-service pair.
- [ ] Assert both redirect files are short, command-free, and link to the matching canonical language.
- [ ] Run the focused test and confirm it fails against the duplicated guides.
- [ ] Commit the red test as `test(docs): define canonical TCP guide boundary`.

### Task 2: Consolidate the bilingual guides

**Files:**
- Modify: `docs/guide-external-app-to-tcp-services.md`
- Modify: `docs/guide-external-app-to-tcp-services.vi.md`
- Modify: `docs/guide-multi-host-tcp-services.md`
- Modify: `docs/guide-multi-host-tcp-services.vi.md`

- [ ] Merge mode selection, A/B/C setup, limits, identities, revocation, direct mode, production checks, and troubleshooting into both canonical files.
- [ ] Replace each legacy file with a language-correct relocation page.
- [ ] Run focused tests, lint, and `git diff --check`.
- [ ] Commit as `docs(tcp): consolidate external service guides`.

### Task 3: Verify repository and history

**Files:**
- Verify all changed files.

- [ ] Run documentation and script tests, shell syntax checks, lint, client build, and the full test suite.
- [ ] Run root and root-to-HEAD commit audits.
- [ ] Confirm working tree cleanliness and sub-1,000-line commit churn.

## Self-review

- The approved spec maps completely to Tasks 1–3.
- Redirect and canonical filenames are consistent.
- No placeholder implementation steps remain.
