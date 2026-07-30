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
- Start every body item with `- `; indent wrapped lines by two spaces.
- Keep commits below 1,000 changed lines and split unrelated concerns.
- Do not mix dependency updates with formatting or behavior changes.
- Automated merge commits are exempt only when the repository uses GitHub's
  generated merge messages; squash merges must follow the normal policy.

Types: `feat`, `fix`, `refactor`, `test`, `docs`, `ci`, `chore`.

Examples:
- `feat: add HMAC verification to admin endpoint`
- `fix: handle WebSocket reconnection exponential backoff`
- `chore(deps): bump ws from 8.20.0 to 8.21.1`
- `test: add end-to-end TCP tunnel agent test`

## Pull Request Process

1. Ensure `yarn check` passes cleanly without errors
2. Update documentation if needed
3. Submit a PR with a clear description of the changes
4. A maintainer will review and provide feedback

## Code of Conduct

Please note that this project follows a Code of Conduct. By participating, you agree to uphold its standards.

