# Publishing

## Before the first release

1. **Finalize the package name and scope** in `package.json` (`"name"` field).
   The current value `@cplugin.com/webapi-sdk` is a working placeholder.
2. **Update repository URLs** — replace `PLACEHOLDER_ORG/PLACEHOLDER_REPO` in
   `package.json` (`repository.url`, `homepage`, `bugs.url`) with the real
   GitHub org and repo name.
3. **Add the `NPM_TOKEN` secret** to the GitHub repository:
   _Settings → Secrets and variables → Actions → New repository secret_
   Generate an Automation token at `https://www.npmjs.com/settings/<user>/tokens`.

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
