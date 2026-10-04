# @mywebapi.com/sdk

TypeScript client for the CPlugin WebAPI v2 — a management API for trading-platform servers.

**Status:** Version `0.3.2`. The package keeps the generated REST catalog and typed MT4/MT5 realtime clients in one entry point; minor releases may introduce breaking changes while the package remains at `0.x`. Pin a version in production.

- **Auto-generated types** from the live OpenAPI spec — all endpoints, DTOs, and enums are exact and stay in sync with the server.
- **Unified entry point** — `CPluginWebApiClient` with `mt4` and `mt5` namespaces; credentials and token management configured once at instantiation.
- **Envelope-aware** — automatic unwrapping of API responses; failures throw `ApiError` carrying `code`, `description`, and `activityId`.
- **Server timeouts** — per-call and client-wide `requestTimeout`; the client deadline always outlasts the server's, and uncertain trades are never repeated automatically.
- **Pagination helper** — `paged()` and `collectAll()` for cursor-based v2 list endpoints.
- **Native fetch foundation** — uses platform `fetch` (Web API / Node.js 18+), injectable for testing.

The WebAPI works with MetaTrader 4 and MetaTrader 5 servers, so a Node.js or browser application gets REST and WebSocket (SignalR) access to a broker's trade server without installing native Windows platform libraries.

- Product and sign-up: <https://mywebapi.com>
- API reference: <https://cplugin.com/docs/webapi> · interactive: <https://cloud.mywebapi.com/swagger>
- Pricing: <https://cplugin.com/docs/pricing-and-terms>
- SDK reference (TypeDoc): <https://cplugin.github.io/mywebapi.com-sdk-js/>

## What brokers do with it

Typical back-office tasks, each with the SDK call that performs it. `client` is created as in [Quick start](#quick-start); `tp` is the trade platform id from the Toolbox.

**List open positions of a group** (MT4 `AdmTradesRequest`, MT5 `PositionByGroup`):

```typescript
const mt4Trades = await client.mt4.getAdmTradesRequestGroup(tp, 'real-usd', { openOnly: true });
const mt5Positions = await client.mt5.getPositionByGroupMask(tp, 'real\\*');
for (const p of mt5Positions) console.log(p.login, p.symbol, p.volume, p.profit);
```

**Stream trades in real time** (SignalR hub; the MT4 hub streams trades, ticks, account and symbol changes and margin calls):

```typescript
const rt = client.realtime.mt4(tp);
await rt.start();
for await (const t of rt.streamTrades()) {
  console.log(t.kind, t.order, t.login, t.symbol, t.volumeLots);
}
```

**Open an account from a CRM** (`UserRecordNew`, then `UserPasswordSet`):

```typescript
const user = await client.mt4.postUserRecordNew(tp,
  { login: 0, group: 'real-usd', name: 'John Smith', email: 'john@example.com', leverage: 100 },
  { headers: { 'Idempotency-Key': crmRequestId } });
await client.mt4.postUserPasswordSetLogin(tp, user.login!, newPassword);
```

**Post a deposit or a withdrawal** (`TradeTransaction` balance operation; a negative amount withdraws):

```typescript
await client.mt4.postTradeTransaction(tp,
  { tradeTransactionType: 'BrBalance', tradeCommand: 'Balance', orderBy: 1001, price: 500, comment: 'Deposit #8812' },
  { headers: { 'Idempotency-Key': paymentId } });
```

**Move an account to another group or change its leverage** (JSON Merge Patch, MT4 and MT5):

```typescript
await client.mt4.patchUserRecordLogin(tp, 1001, { group: 'real-vip', leverage: 200 });
await client.mt5.patchUserRecordLogin(tp, 50001, { leverage: 200 });
```

**Read trade history for reports and statements** (`TradesUserHistory`, MT5 `DealByGroup`):

```typescript
const closed = await client.mt4.getTradesUserHistoryLogin(tp, 1001,
  { fromTime: '2026-09-01T00:00:00Z', toTime: '2026-10-01T00:00:00Z' });
const mt5Deals = await client.mt5.getDealByGroupMask(tp, 'real\\*', { limit: 1000 });
```

**Watch margin levels** (cached snapshot of every account, then the live margin-call stream):

```typescript
const atRisk = (await client.mt4.getMarginsGet(tp)).filter((m) => (m.level ?? 0) > 0 && (m.level ?? 0) < 100);
const rt = client.realtime.mt4(tp);
await rt.start();
for await (const m of rt.streamMarginCallUpdates()) console.log('margin call', m.login, m.level);
```

**Change symbol settings, for example swaps** (`SymbolConfig` on MT4, `SymbolRecord` on MT5):

```typescript
await client.mt4.patchSymbolConfigSymbol(tp, 'EURUSD', { swapLong: -6.1, swapShort: 1.2 });
await client.mt5.patchSymbolRecordSymbol(tp, 'EURUSD', { swapLong: -6.1, swapShort: 1.2 });
```

Every other endpoint (trading groups, server configuration, backups, journal, charts, news, plugins) is a method on `client.mt4` or `client.mt5`; see the [API reference](https://cplugin.com/docs/webapi) and the [TypeDoc pages](https://cplugin.github.io/mywebapi.com-sdk-js/).

## Install

```bash
bun add @mywebapi.com/sdk
# or: npm / pnpm install @mywebapi.com/sdk
```

**Credentials & trade platforms:** Create API keys (client ID and client secret) and manage your trade platforms in the CPlugin Toolbox — staging: https://pre.toolbox.cplugin.com · production: https://toolbox.cplugin.com

## Quick start

The SDK manages OAuth2 access tokens for you — pass `clientId` / `clientSecret` and the SDK handles discovery, caching, expiry, and 401-driven refresh transparently. Credentials and environment are configured once; then call methods on `client.mt4` or `client.mt5` namespaces.

```typescript
import { CPluginWebApiClient, ApiError, collectAll } from '@mywebapi.com/sdk';

const client = new CPluginWebApiClient({
  env: 'prod',  // or 'staging' or { env: 'custom', apiBaseUrl, authority }
  clientId: 'your-client-id',
  clientSecret: process.env.CPLUGIN_WEBAPI_CLIENT_SECRET!,
});

// server time (mt4 namespace)
const tp = '3029d415-d0a6-4710-a9c1-8cb063ef872f';
const time = await client.mt4.getServerTime(tp);
console.log('server time (mt4):', time);

// server time (mt5 namespace)
const mt5Time = await client.mt5.getServerTime(tp);
console.log('server time (mt5):', mt5Time);
// Pagination — single page with cursor capture
const page = await client.paged(() =>
  client.mt4.getOnlineGet(tp, { limit: 50 }),
);
console.log(`Page items: ${page.items.length}, has more: ${page.paging?.hasMore}`);

// Collect all items across pages
const allUsers = await collectAll((cursor) =>
  client.paged(() =>
    client.mt4.getUsersRequest(tp, { limit: 100, ...(cursor ? { cursor } : {}) }),
  ),
);
console.log(`Fetched ${allUsers.length} users across all pages`);

// Async iteration over pages
import { paginate } from '@mywebapi.com/sdk';
for await (const pageItems of paginate((cursor) =>
  client.paged(() =>
    client.mt4.getUsersRequest(tp, { limit: 50, ...(cursor ? { cursor } : {}) }),
  ),
)) {
  for (const user of pageItems) {
    console.log(user.login, user.balance);
  }
}

// Error handling
try {
  await client.mt4.getUserRecordGetLogin(tp, 99999999);
} catch (e) {
  if (e instanceof ApiError) {
    console.error('API error:', {
      code: e.code,
      description: e.description,
      activityId: e.activityId,
    });
  }
}
```

### Configuration from environment variables

The client constructor is the single configuration API. Read environment variables in the application and pass the supported fields explicitly; there is no `fromEnvironment()` factory.

```typescript
const client = new CPluginWebApiClient({
  env: (process.env.CPLUGIN_WEBAPI_ENV === 'staging' ? 'staging' : 'prod'),
  clientId: process.env.CPLUGIN_WEBAPI_CLIENT_ID!,
  clientSecret: process.env.CPLUGIN_WEBAPI_CLIENT_SECRET!,
});
```

### Request deadlines and cancellation

REST operations and each OAuth discovery/token request have a bounded deadline. Configure the minimum REST deadline with `timeoutMs` (the default is 30 seconds):

```typescript
const client = new CPluginWebApiClient({
  env: 'prod',
  clientId: process.env.CPLUGIN_WEBAPI_CLIENT_ID!,
  clientSecret: process.env.CPLUGIN_WEBAPI_CLIENT_SECRET!,
  timeoutMs: 10_000,
});
```

The deadline covers token acquisition, the API request, and response-body decoding. Cancellation and timeout errors are propagated rather than being reported as malformed JSON. For operations with a server timeout the deadline is extended automatically — see [Timeouts and retries](#timeouts-and-retries).

### Static token (advanced realtime/testing)

The unified REST client uses client credentials. For a pre-issued JWT in a test rig or a direct realtime client, use the exported `StaticTokenProvider`; no refresh is performed.

```typescript
import { MT4V2SignalRClient, StaticTokenProvider } from '@mywebapi.com/sdk';

const rt = new MT4V2SignalRClient({
  baseUrl: 'https://cloud.mywebapi.com',
  tradePlatform: process.env.CPLUGIN_WEBAPI_TRADE_PLATFORM!,
  tokenProvider: new StaticTokenProvider(process.env.CPLUGIN_WEBAPI_ACCESS_TOKEN!),
});
```

## Timeouts and retries

### Server timeouts

The server bounds every call to a trading platform with a timeout that depends on the kind of operation:

| Operation kind | Examples | Default |
|---|---|---|
| Trade | trade transactions, stop checks, trade record edits | 5 s |
| Read | records, symbols, groups, server time | 10 s |
| Change | account, group and symbol updates | 15 s |
| History | trade history, reports, ticks and charts, journals, backup listings | 30 s |
| Maintenance | backup restore, server restart, synchronisation, bulk account operations | 60 s |

The exact default of each method is stated in its JSDoc (`**Timeout:** … s by default`). Change it per call, or for the whole client, with `requestTimeout` in seconds (1–300, fractions allowed). The SDK sends it as the `X-Request-Timeout` header; the server reports the value it applied in `ApiError.appliedTimeout`.

```typescript
const client = new CPluginWebApiClient({
  env: 'prod',
  clientId: '...',
  clientSecret: '...',
  requestTimeout: 20,                      // every operation that has a server timeout
});

await client.mt4.getTradesUserHistoryLogin(tp, 817542, { fromTime, toTime }, { requestTimeout: 120 });   // this call only
```

A per-call value overrides the client-wide one; a value outside 1–300 throws a `TypeError` before anything is sent. Every generated method, the MT4 x86 sidecar ones included, has a server timeout; the client-wide value is not sent only to `listTradePlatforms()`, which does not call a trading platform.

The client deadline is kept longer than the server timeout: `max(timeoutMs, server timeout + 30 s)`, where the server timeout is the requested one or the operation's default. The margin covers the up to 20 s the server may add while it opens the trading platform connection for this request, plus transfer time, so the server's own answer arrives instead of a local abort. A short `requestTimeout` therefore does not make the client give up sooner than about 30 s; use an `AbortSignal` in the options for a hard local limit.

### Error codes

| `code` | `outcome` | Meaning | What to do |
|---|---|---|---|
| `Timeout` | `timeout` | A read did not finish in time. Nothing was changed. | Safe to repeat. |
| `Busy` | `not-started` | Refused before it was sent to the trading server. Nothing was executed. | Safe to repeat, preferably after a pause. |
| `OutcomeUnknown` | `unknown` | A trade or change did not finish in time and **may still be applied** by the server. | Do not repeat blindly — see below. |
| `OutcomeUnknown` | `in-progress` | A request with the same `Idempotency-Key` is still running; this one was not executed. | Repeat later with the same key. |

`outcome` is the `X-Request-Outcome` response header, available as `ApiError.outcome`. Two helpers classify any caught value:

- `isRetryable(err)` — the server says the request changed nothing and may be sent again as is (`Timeout`, `Busy`).
- `isOutcomeUnknown(err)` — the server does not know yet whether the operation took effect (`OutcomeUnknown`).

Both return `false` for anything that is not an `ApiError`. A network error or a client deadline abort on a `POST`/`PATCH` is just as uncertain as `OutcomeUnknown`, and is recovered the same way.

### Safe recovery with `Idempotency-Key`

Send an `Idempotency-Key` with every trade or change. The server reserves the key when the request starts: a repeat while the first request is still running is answered with `OutcomeUnknown` / `in-progress` and **not executed**; a repeat after it finished returns the original result. Repeating the same request with the same key is therefore the safe way to learn the outcome: within the server's idempotency window it never executes the operation twice. Transient answers (`Busy`, `Timeout`, `NoConnect`, `Internal`) are not stored, so a repeat after them executes normally.

```typescript
import { ApiError, isOutcomeUnknown, isRetryable } from '@mywebapi.com/sdk';

const key = crypto.randomUUID();                  // one key per logical operation, reused on every repeat
const send = () =>
  client.mt4.postTradeTransaction(tp, transaction, { headers: { 'Idempotency-Key': key } });

async function sendWithRecovery(maxAttempts = 5) {
  for (let attempt = 1; ; attempt++) {
    try {
      return await send();
    } catch (err) {
      // * Network errors and client aborts are as uncertain as OutcomeUnknown.
      const uncertain = isOutcomeUnknown(err) || !(err instanceof ApiError);
      if (attempt >= maxAttempts || !(uncertain || isRetryable(err))) throw err;
      await new Promise((resolve) => setTimeout(resolve, attempt * 2_000));   // then: same request, same key
    }
  }
}
```

Without an `Idempotency-Key`, check the resulting state (for example the account's open trades) before sending a trade again.

### Automatic retries

The SDK repeats a request by itself only when that is safe by HTTP semantics, and only on transient transport failures (`408`, `429`, `502`, `503`, `504`) and retryable network errors:

- `GET`, `HEAD`, and `OPTIONS` — safe by definition.
- `PUT` and `DELETE` — treated as idempotent by the transport.
- `POST` and `PATCH` — never repeated automatically, even when an `Idempotency-Key` header is present.

Envelope errors — including `Timeout`, `Busy` and `OutcomeUnknown` — are never repeated automatically; the helpers above leave the decision to the caller. An aborted request is never retried. Backoff is exponential (default 3 attempts, base 500 ms, factor 2, ±25% jitter) with `Retry-After` honoured (both `delta-seconds` and HTTP-date forms). All attempts share the one request deadline. Override per-client:

```typescript
const client = new CPluginWebApiClient({
  env: 'prod',
  clientId: '...',
  clientSecret: '...',
  retry: { maxAttempts: 5, baseDelayMs: 200 },
});
```

## Error handling

`ApiError` is thrown for any API-level failure. It carries `code`, `description`, and `activityId` for diagnostics and correlation.

```typescript
import { ApiError } from '@mywebapi.com/sdk';

const tp = '3029d415-d0a6-4710-a9c1-8cb063ef872f';

try {
  await client.mt4.getUserRecordGetLogin(tp, 99999999);
} catch (e) {
  if (e instanceof ApiError) {
    console.error('API error:', {
      code: e.code,
      description: e.description,
      activityId: e.activityId,
    });
  } else {
    console.error('Network or auth error:', e instanceof Error ? e.message : e);
  }
}
```

## Idempotency

Mutating endpoints accept an optional `Idempotency-Key` header, passed in the options argument like any other header. The SDK forwards it to the server for its own deduplication and does not treat it as permission to replay `POST` or `PATCH`.

```typescript
const tp = '3029d415-d0a6-4710-a9c1-8cb063ef872f';

await client.mt4.postTradeTransaction(tp, transaction, {
  headers: { 'Idempotency-Key': 'my-request-id-12345' },
});
```

Keys are private to your API client and to the operation. A repeated key returns the original result instead of executing again; see [Safe recovery with `Idempotency-Key`](#safe-recovery-with-idempotency-key).

## Pagination helpers

The SDK exports `paged()`, `paginate()`, and `collectAll()` helpers for paginated endpoints.

**`client.paged(call)`** — wraps a single generated method call, capturing cursor metadata:

```typescript
const tp = '3029d415-d0a6-4710-a9c1-8cb063ef872f';

const page = await client.paged(() =>
  client.mt4.getTradesGet(tp, { limit: 50 }),
);
console.log(page.items, page.paging?.nextCursor, page.paging?.hasMore);
```

**`collectAll(fetchPage)`** — flattens all pages into a single array (requires `paged()` wrapper):

```typescript
const allTrades = await collectAll((cursor) =>
  client.paged(() =>
    client.mt4.getTradesGet(tp, { limit: 100, ...(cursor ? { cursor } : {}) }),
  ),
);
console.log(`Total trades: ${allTrades.length}`);
```

**`paginate(fetchPage)`** — async iterable for streaming large datasets page-by-page:

```typescript
import { paginate } from '@mywebapi.com/sdk';

for await (const pageItems of paginate((cursor) =>
  client.paged(() =>
    client.mt4.getTradesGet(tp, { limit: 100, ...(cursor ? { cursor } : {}) }),
  ),
)) {
  // process pageItems without loading everything into memory
}
```

## Development

```bash
bun install
bun run generate      # regenerate src/generated/
bun run typecheck

# Integration tests against the live WebAPI — needs env vars (or a .env file):
#   WEBAPI_BASE_URL, WEBAPI_AUTH_SERVER, WEBAPI_CLIENT_ID, WEBAPI_CLIENT_SECRET,
#   WEBAPI_TRADE_PLATFORM, WEBAPI_KNOWN_LOGIN
bun run test

bun run build         # outputs dist/index.js + dist/*.d.ts
```

## SignalR (real-time streams)

Real-time streaming clients are exported from this package. `@microsoft/signalr` is a required runtime dependency and is installed with the SDK; the build keeps the official package external so consumers can use their normal bundler/runtime.


Open a hub from the same client — it reuses the client's environment and OAuth token:

```ts
const rt = client.realtime.mt4(tradePlatform);   // or client.realtime.mt5(tradePlatform)
rt.onConnectionStatus((s) => console.log('connected:', s.connected));
await rt.start();
for await (const tick of rt.streamTicks('EURUSD')) {
  console.log(tick.symbol, tick.bid, tick.ask);
}
await rt.stop();
```

The `mt4` hubs expose ticks, trades, margin-call, user and symbol streams; the `mt5` hubs expose connection status and margin-call updates.

Hub method calls addressed to a trading platform (such as subscribing to ticks) and the hub connection itself fail with an error when the trading server does not answer within 60 s; open streams are not affected.

## What's next

- Add typed convenience wrappers for every v2 endpoint as usage patterns crystallise.
- Progress toward a stable `1.0.0` once the v2 API reaches production maturity.

New versions are cut by tagging a release (`vX.Y.Z`), which publishes `@mywebapi.com/sdk` to npm via the GitHub Actions workflow — see [PUBLISHING.md](./PUBLISHING.md).

## Contributing

Contributions are welcome — see [CONTRIBUTING.md](./CONTRIBUTING.md) for the development setup, the generated-code workflow, and PR guidelines.

## Security

To report a security vulnerability, please follow the responsible-disclosure process in [SECURITY.md](./SECURITY.md). Do not open public issues for security reports.

## Trademarks

MetaTrader, MT4, MT5, and MetaQuotes are trademarks or registered trademarks of MetaQuotes Ltd.
This project is an independent, community-oriented SDK for the WebAPI service.
It is **not affiliated with, endorsed by, or sponsored by MetaQuotes Ltd.**

All other trademarks are the property of their respective owners.

## License

MIT — see [LICENSE](./LICENSE).
