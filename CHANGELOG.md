# Changelog

All notable changes to `@mywebapi.com/sdk`. The package follows [semver](https://semver.org/); while it is at `0.x`, a minor release may contain breaking changes.

## 0.3.2

Batched real-time ticks on both v2 hubs, for consumers that prefer one flush per interval over a callback per tick.

### Added

- `MT4V2SignalRClient` and `MT5V2SignalRClient`: `onTicksBatch(handler)`, `subscribeToTicksBatch(symbol, intervalMs?, maxBatchSize?)` and `unsubscribeFromTicksBatch(symbol)` for the `OnTicksBatch` / `SubscribeToTicksBatch` / `UnsubscribeFromTicksBatch` methods of `/hubs/mt4/v2` and `/hubs/mt5/v2`, plus the `MT4TicksBatchPayload` and `MT5TicksBatchPayload` types (`symbol`, `ticks`). A batch carries the same tick shape as `OnTick`. `intervalMs` is 20–60000 (default 200) and `maxBatchSize` is 1–10000 (default 200); out-of-range values are rejected by the server.
- While a symbol is subscribed to batches, its per-tick `OnTick` events are not delivered. Batch subscriptions last until `unsubscribeFromTicksBatch(symbol)` or until the connection closes.

## 0.3.1

MT5 market history over REST and real-time ticks over the MT5 v2 hub. The specification is regenerated from the server, and the MT4 x86 sidecar operations stay available.

### Added

- `GET /api/v2/MT5/{tradePlatform}/ChartRequest/{symbol}` — `client.mt5.getChartRequestSymbol(tradePlatform, symbol, { period, from?, to?, limit })`. Returns OHLC bars ordered by time ascending, with `total` and `truncated`; `period` is `M1`, `M5`, `M15`, `M30`, `H1`, `H4` or `D1`; `limit` 0 means the whole window.
- `GET /api/v2/MT5/{tradePlatform}/TicksHistory/{symbol}` — `client.mt5.getTicksHistorySymbol(tradePlatform, symbol, { from?, to?, limit })`. Returns ticks ordered by time ascending with `total` and `truncated`; `limit` 0 means the whole window.
- `MT5V2SignalRClient`: `onTick(handler)`, `subscribeToTicks(symbol)`, `unsubscribeFromTicks(symbol)` and `streamTicks(symbol?)` for the `OnTick` / `SubscribeToTicks` / `UnsubscribeFromTicks` / `StreamTicks` methods of `/hubs/mt5/v2`, plus the `MT5TickPayload` type (`symbol`, `bid`, `ask`, `last`, `lastTime`, `volumeExt`, `flags`). The margin-call stream is unchanged.

### Changed

- Regenerated from the current server specification: 174 operations. The 13 MT4 x86 sidecar operations, which the current x64 specification does not list, are preserved in `spec/v2.json` with their schemas.

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
