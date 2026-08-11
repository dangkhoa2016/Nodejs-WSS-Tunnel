# Contributing

Thank you for considering contributing to this project. Please follow these guidelines to ensure a smooth process.

## Getting Started

1. Fork the repository
2. Clone your fork: `git clone https://github.com/<your-username>/Nodejs-WSS-Tunnel.git`
3. Set up the project:
   ```bash
   corepack enable
   yarn install
   ```
4. Create a feature branch: `git checkout -b feat/my-feature`

## Development

### Prerequisites

- Node.js 20+ (Node 20, 22, or 24)
- Corepack / Yarn 4 (`yarn@4.17.1`)

### Development & Production Server

```bash
# Start development server
yarn dev

# Start production server
yarn prod
```

### Running Tests

```bash
# Full test suite
yarn test

# Specific test file
node --test test/websocket-auth.test.js

# With TCP services enabled (Redis / Postgres required)
REQUIRE_TCP_SERVICES=1 yarn test
```

### Linting & Formatting

```bash
# Check linting rules with Biome
yarn lint

# Fix linting issues automatically
yarn lint:fix

# Format codebase
yarn format

# Build client standalone bundles
yarn build:client

# Run full check suite (lint + test + build:client)
yarn check
```

## Commit Messages

We use [Conventional Commits](https://www.conventionalcommits.org/):

```
type(scope): short description

- Bullet point explaining change
- Another bullet point if needed
```

### Commit message rules

- Use `type(scope): imperative summary` or `type: imperative summary`.
- Keep the subject at or below 72 characters.
- Separate the body with one blank line.
- Start every body item with `- ` and keep each bullet on a single line.
- Keep commits below 1,000 changed lines and split unrelated concerns.
- Do not mix dependency updates with formatting or behavior changes.
- Merge commits must follow the same subject and body rules. GitHub-generated
  merge messages rarely do, so edit them before merging or use squash merges;
  CI audits the resulting history on every push to `main`.

Types: `build`, `chore`, `ci`, `docs`, `feat`, `fix`, `perf`, `refactor`,
`revert`, `style`, `test`.

Examples:
- `feat: add HMAC verification to admin endpoint`
- `fix: handle WebSocket reconnection exponential backoff`
- `chore(deps): bump ws from 8.20.0 to 8.21.1`
- `test: add end-to-end TCP tunnel agent test`

### History policy audit

CI enforces the history policy on every pull request and on every push to
`main` with `scripts/audit-commits.js`. Run the same check locally before
opening a PR:

```bash
yarn audit:commits --base origin/main --head HEAD
```

The audit rejects:

- Subjects longer than 72 characters.
- Subjects that do not follow Conventional Commits
  (`type(scope)!?: description`, types: `build`, `chore`, `ci`, `docs`,
  `feat`, `fix`, `perf`, `refactor`, `revert`, `style`, `test`).
- Body lines that are neither `- ` bullets nor valid Git trailers such as
  `Signed-off-by:`.
- Commits with at least 1,000 lines of changed code (additions plus
  deletions). Binary files reported as `-` by `git --numstat` are ignored.

## Pull Request Process

1. Ensure `yarn check` passes cleanly without errors
2. Update documentation if needed
3. Submit a PR with a clear description of the changes
4. A maintainer will review and provide feedback

## Code of Conduct

Please note that this project follows a Code of Conduct. By participating, you agree to uphold its standards.

