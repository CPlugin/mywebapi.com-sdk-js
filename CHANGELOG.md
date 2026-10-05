# Changelog

All notable changes to `@mywebapi.com/sdk`. The package follows [semver](https://semver.org/); while it is at `0.x`, a minor release may contain breaking changes.

## 0.3.3

Regenerated from the WebAPI v2 specification of 05.10.2026; no change to the API surface or to the request and response types.

### Changed

- The specification header (`info.description`) and the operation and schema descriptions in the generated code and in the API reference no longer name the server's internal library. The header now describes the API itself: it works with MetaTrader 4 and MetaTrader 5 trade servers and keeps a live connection to each of them.
- Documentation only; no change in behaviour.

## 0.3.2

### Fixed

- Package description shortened to fit npm's 255-character limit: the registry cut the 0.3.1 description mid-word and dropped its trademark notice. The release check (`ci/check-version.mjs`) now refuses a longer description. No code changes.

## 0.3.1

Regenerated from the WebAPI v2 specification of 03.10.2026; no change to the API surface or to the request and response types.

### Changed

- The MT4 enum fields of `MT4TradeTransaction` (`tradeTransactionType`, `tradeCommand`, `tradeRequestFlags`, used by `postTradeTransaction` and `postTradeCheckStops`) and `MT4UsersGroupOp.command` now document the values the server accepts; the old descriptions listed names such as `ModifyTrade` and `BalanceAdd` that the server does not know. Values are case-insensitive, and the numeric value is accepted too.
- An unknown value in `tradeTransactionType`, `tradeCommand` or `MT4UsersGroupOp.command` is now refused by the server with an `ApiError` whose `code` is `Validation`; until 03.10.2026 it was silently replaced by the enum's default. The behaviour belongs to the server, so it applies to every SDK version; check code that builds these values from user input.

### Documentation

- README: "What brokers do with it" — eight common back-office tasks (open positions of a group, trade stream, account creation, deposits and withdrawals, group and leverage changes, trade history, margin levels, symbol swaps), each with the SDK call that performs it; links to the product site, API reference and pricing.
- Package metadata: `homepage` is now <https://mywebapi.com>; the description and keywords name the compatible trading platforms (MetaTrader 4 and MetaTrader 5).
- Landing page (`docs/index.html`): the quick-start snippet called a `fromEnvironment()` factory that does not exist and read `time.data.timestamp` from an already unwrapped value; both corrected. The footer no longer shows a stale version and carries the trademark notice.

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

- The six v2 `PATCH` methods (`patchUserRecordLogin`, `patchGroupRecordGroup` on both platforms, `patchSymbolConfigSymbol`, `patchSymbolRecordSymbol`) now take the patch object — only the fields to change — as a typed argument before `options`, and send it as `application/json`. Before, the spec did not describe the body, so these methods could not send one. `postExternalCommandJSON` takes its command the same way. Calls written as `(tradePlatform, key, options)` must insert the patch object.

- Regenerated from the current server spec: every guarded operation documents its default timeout in JSDoc.
- The 13 MT4 x86 sidecar methods (`getPluginsGet`, `getPluginParamGetPos`, `getCfgRequestPlugin`, `postPluginUpdate`, `postCfgUpdatePlugin`, `getMailsRequest`, `postMailSend`, `postNewsSend`, `getUsersSnapshot`, `getUsersSyncRead`, `getTradesSnapshot`, `getTradesSyncRead`, `postExternalCommandBinary`) now have server timeouts too: they receive the client-wide `requestTimeout`, and their deadline is extended to the server default (10–60 s) plus the 30 s margin.
- Flag types (for example `UsersRights`, `GroupRights`, `EnTradeRightsFlags`) are now `string` — the names of the set bits joined by `", "` — instead of a union of single names, which could not represent a combination. Code comparing such a field with one name must check for membership instead.
- Calls that previously timed out locally at 30 s (history 30 s and maintenance 60 s server defaults) now wait for the server's answer.
- The `options` argument of every generated method is typed as the SDK's own call options (including `requestTimeout`) instead of plain `RequestInit`, and headers passed there as a `Headers` object or an array of pairs are now kept when the method adds its own `Content-Type` — before, spreading a `Headers` object dropped them.

### Unchanged on purpose

- `POST` and `PATCH` are never repeated automatically — not on `OutcomeUnknown`, not on `in-progress`, not on network errors or aborts. Envelope errors, including `Busy` and `Timeout`, are never repeated automatically either; the helpers leave that decision to the caller.

### Fixed

- Development: the code generator (orval) is updated from 8.19.0 to 8.38.0, which fixes code-execution flaws triggered by a malicious OpenAPI document at generation time. The published package never contained the generator.

- README idempotency example passed the key in a form the transport ignores; it now uses `{ headers: { 'Idempotency-Key': … } }`.
