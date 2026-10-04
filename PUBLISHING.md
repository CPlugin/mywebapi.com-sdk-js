# Publishing

## Before the first release

1. **Package name** — `@mywebapi.com/sdk` (npm org `mywebapi.com` must exist).
2. **Repository URLs** — `package.json` points `repository.url` and `bugs.url`
   at `CPlugin/mywebapi.com-sdk-js`; `homepage` is the product site,
   <https://mywebapi.com>.
3. **Authentication: npm Trusted Publishing (OIDC) — no token to store or rotate.**
   - First publish is a one-time bootstrap (npm needs the package to exist before
     a Trusted Publisher can be attached): publish `v0.1.0` once using a short-lived
     npm automation token, or run `npm publish --access public` from your machine.
   - Then on npmjs.com: _Package → Settings → Trusted Publisher → GitHub Actions_,
     set the GitHub org/repo and workflow file `publish.yml`.
   - Every later release publishes via the workflow's OIDC id-token — **no
     `NPM_TOKEN` secret, nothing to rotate** (granular write tokens otherwise
     expire in ≤90 days).

## Releasing a version

1. Bump `"version"` in `package.json` following [semver](https://semver.org/) and add
   the release notes to [CHANGELOG.md](./CHANGELOG.md).
2. Open a pull request to `main` with the change and the version bump, and merge it once CI is green — `main` accepts changes only through a pull request with passing CI.
3. Tag the commit and push the tag (the tag must equal `v` + the `package.json` version,
   `ci/check-version.mjs` rejects anything else):
   ```sh
   git tag -a vX.Y.Z -m "vX.Y.Z"
   git push origin vX.Y.Z
   ```
4. The `publish.yml` workflow triggers automatically, builds the package, and
   publishes it to npm with provenance attestation.

## Regenerating the client from a new spec

```sh
# Copy the server's exported spec to spec/v2.json unchanged, then:
bun run generate   # rewrites src/generated/ and src/request-timeouts.generated.ts
bun test           # verify nothing broke
bun run build      # confirm the build still succeeds
```

`orval.config.ts` normalises the spec in memory before generation (em dashes in
tags become hyphens so module file names stay stable), so
`spec/v2.json` stays byte-identical to what the server publishes.
`src/request-timeouts.generated.ts` holds each operation's server timeout from the
`X-Request-Timeout` parameter; a test fails when it is out of date.

## Release gate

- Only repository admins can create `v*` tags; nobody can move or delete one (repository rulesets), so a published version always points at the commit it was built from.
- `main` accepts changes only through a pull request whose CI passed. Merging that pull request is the review of what will be released.
- The first job of `publish.yml` (`Release gate`) refuses a tag whose commit is not on `main` or has no successful CI run; nothing is built or published then. Fix it by merging the commit into `main` and tagging the merged commit — a refused tag cannot be moved, so the next version number is used.
