# Changelog

All notable changes to `@mywebapi.com/sdk`. The package follows [semver](https://semver.org/); while it is at `0.x`, a minor release may contain breaking changes.

## 0.3.0

Support for server-side request timeouts. Servers released before this feature do not read `X-Request-Timeout` and never send the new codes, so the SDK keeps working against them.

### Added

- `requestTimeout` (seconds, 1–300) — per call in the options argument of every generated method, and client-wide in `CPluginWebApiClient` options. Sent as `X-Request-Timeout`; out-of-range values throw a `TypeError` before anything is sent.
- The client deadline is extended automatically to `server timeout + 30 s` (requested value, or the operation's default from the spec; the margin covers the up to 20 s the server may spend opening the platform connection), so the server's own answer is received instead of a local abort. `timeoutMs` is now the minimum deadline: reads now wait up to 40 s instead of 30 s.
- Error codes `Timeout`, `OutcomeUnknown` and `Busy` in `WebApiErrorCode`.
- `ApiError.outcome` (`X-Request-Outcome`: `timeout`, `unknown`, `not-started`, `in-progress`) and `ApiError.appliedTimeout` (`X-Request-Timeout-Applied`).
- `isOutcomeUnknown(err)` and `isRetryable(err)` helpers; `RequestOptions`, `RequestOutcome`, `REQUEST_TIMEOUT_MIN_SECONDS`, `REQUEST_TIMEOUT_MAX_SECONDS`, `SERVER_ANSWER_MARGIN_MS` exports.
- README section "Timeouts and retries": defaults per operation kind, error codes, safe recovery with `Idempotency-Key`.

### Changed

- Regenerated from the current server spec: every guarded operation documents its default timeout in JSDoc.
- Flag types (for example `UsersRights`, `GroupRights`, `EnTradeRightsFlags`) are now `string` — the names of the set bits joined by `", "` — instead of a union of single names, which could not represent a combination. Code comparing such a field with one name must check for membership instead.
- Calls that previously timed out locally at 30 s (history 30 s and maintenance 60 s server defaults) now wait for the server's answer.

### Unchanged on purpose

- `POST` and `PATCH` are never repeated automatically — not on `OutcomeUnknown`, not on `in-progress`, not on network errors or aborts. Envelope errors, including `Busy` and `Timeout`, are never repeated automatically either; the helpers leave that decision to the caller.

### Fixed

- README idempotency example passed the key in a form the transport ignores; it now uses `{ headers: { 'Idempotency-Key': … } }`.
