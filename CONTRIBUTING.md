# Contributing to `@mywebapi.com/sdk`

Thanks for your interest in improving the SDK! This document covers how to set
up the project, the conventions we follow, and what we look for in a pull
request.

## Code of conduct

Be respectful and constructive. We expect contributors to act professionally in
issues, pull requests, and reviews.

## Reporting issues

- **Bugs / feature requests:** open a
  [GitHub issue](https://github.com/CPlugin/mywebapi.com-sdk-js/issues). Please
  include the SDK version, a minimal reproduction, and the observed vs. expected
  behaviour.
- **Security vulnerabilities:** do **not** open a public issue. Follow the
  responsible-disclosure process in [SECURITY.md](./SECURITY.md)
  (security@cplugin.com).

## Prerequisites

- [Bun](https://bun.sh/) `>= 1.0.0` (the project's package manager and test
  runner).
- Node.js 18+ is required only at runtime by consumers; development uses Bun.

## Getting started

```bash
git clone https://github.com/CPlugin/mywebapi.com-sdk-js.git
cd mywebapi.com-sdk-js
bun install
```

## Development workflow

```bash
bun run typecheck     # tsc --noEmit
bun run test          # unit tests (E2E skipped unless WEBAPI_E2E=1)
bun run build         # outputs dist/index.js + dist/*.d.ts
```

Before opening a PR, make sure **typecheck and tests pass** — these are the same
checks CI runs (see `.github/workflows/ci.yml`).

### Generated code

The API surface (`src/generated/`) is **auto-generated** from the OpenAPI spec
via [orval](https://orval.dev/) — **do not edit generated files by hand**. To
refresh them after a spec change:

```bash
bun run fetch-spec    # download swagger.json from a running WebAPI (WEBAPI_BASE_URL)
bun run generate      # regenerate src/generated/ from the spec
bun run typecheck     # confirm nothing broke
```

Hand-written code (the client, helpers, retry/auth logic, realtime) lives
outside `src/generated/`. Put your changes there.

### Integration / E2E tests

Integration tests run against a live WebAPI and are skipped by default. To run
them locally, provide the required environment variables (or a `.env` file) and
set `WEBAPI_E2E=1`:

```
WEBAPI_BASE_URL, WEBAPI_AUTH_SERVER, WEBAPI_CLIENT_ID, WEBAPI_CLIENT_SECRET,
WEBAPI_TRADE_PLATFORM, WEBAPI_KNOWN_LOGIN
```

```bash
bun run test:e2e
```

**Never commit real credentials, secrets, or tokens.** Use `.env` (git-ignored)
or placeholder values in examples and tests.

## Pull request guidelines

1. **Fork and branch** from `main` using a descriptive branch name
   (`fix/...`, `feat/...`, `docs/...`).
2. **Keep PRs focused** — one logical change per PR; avoid unrelated drive-by
   refactors.
3. **Add or update tests** for behavioural changes.
4. **Update documentation** (README / examples) when you change public API
   surface.
5. **Pass CI** — typecheck and tests must be green.
6. Write a clear PR description: what changed, why, and how to verify.

## Commit messages

Use clear, imperative commit messages. We encourage (but do not strictly
require) [Conventional Commits](https://www.conventionalcommits.org/) prefixes
such as `feat:`, `fix:`, `docs:`, `chore:`, and `test:`.

## Releasing

Releases are cut by maintainers. The process — version bump, tag, and the
OIDC-based npm publish workflow — is documented in [PUBLISHING.md](./PUBLISHING.md).

## Trademarks

MetaTrader, MT4, MT5, and MetaQuotes are trademarks or registered trademarks of MetaQuotes Ltd.
This project is an independent, community-oriented SDK for the WebAPI service.
It is **not affiliated with, endorsed by, or sponsored by MetaQuotes Ltd.**

All other trademarks are the property of their respective owners.

## License

By contributing, you agree that your contributions will be licensed under the
project's [MIT License](./LICENSE).
