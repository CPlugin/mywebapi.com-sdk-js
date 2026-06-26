# Publishing

## Before the first release

1. **Package name** — `@mywebapi.com/sdk` (npm org `mywebapi.com` must exist).
2. **Update repository URLs** — replace `PLACEHOLDER_ORG/PLACEHOLDER_REPO` in
   `package.json` (`repository.url`, `homepage`, `bugs.url`) with the real
   GitHub org and repo name.
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

1. Bump `"version"` in `package.json` following [semver](https://semver.org/).
2. Commit and push the version bump to `main`.
3. Tag the commit and push the tag:
   ```sh
   git tag v0.2.0
   git push origin v0.2.0
   ```
4. The `publish.yml` workflow triggers automatically, builds the package, and
   publishes it to npm with provenance attestation.

## Regenerating the client from a new spec

```sh
# Drop the new spec into spec/ then:
bun run generate   # rewrites src/generated/ from spec/v2.json
bun test           # verify nothing broke
bun run build      # confirm the build still succeeds
```
