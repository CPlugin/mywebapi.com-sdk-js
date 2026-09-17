# @mywebapi.com/sdk

TypeScript client for the CPlugin WebAPI v2 — a management API for trading-platform servers.

**Status:** Version `0.2.1`. The package keeps the generated REST catalog and typed MT4/MT5 realtime clients in one entry point; minor releases may introduce breaking changes while the package remains at `0.x`. Pin a version in production.

- **Auto-generated types** from the live OpenAPI spec — all endpoints, DTOs, and enums are exact and stay in sync with the server.
- **Unified entry point** — `CPluginWebApiClient` with `mt4` and `mt5` namespaces; credentials and token management configured once at instantiation.
- **Envelope-aware** — automatic unwrapping of API responses; failures throw `ApiError` carrying `code`, `description`, and `activityId`.
- **Pagination helper** — `paged()` and `collectAll()` for cursor-based v2 list endpoints.
- **Native fetch foundation** — uses platform `fetch` (Web API / Node.js 18+), injectable for testing.

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

REST operations and each OAuth discovery/token request have a bounded deadline. Configure the REST deadline with `timeoutMs` (the default is 30 seconds):

```typescript
const client = new CPluginWebApiClient({
  env: 'prod',
  clientId: process.env.CPLUGIN_WEBAPI_CLIENT_ID!,
  clientSecret: process.env.CPLUGIN_WEBAPI_CLIENT_SECRET!,
  timeoutMs: 10_000,
});
```

The deadline covers token acquisition, the API request, and response-body decoding. Cancellation and timeout errors are propagated rather than being reported as malformed JSON.

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

## Retries


Only requests that are safe to replay retry automatically on transient errors (`408`, `429`, `502`, `503`, `504`) and retryable network failures:

- `GET`, `HEAD`, and `OPTIONS` — safe by definition.
- `PUT` and `DELETE` — treated as idempotent by the transport.
- `POST` and `PATCH` — never repeated automatically, even when an `Idempotency-Key` header is present.

An aborted request is never retried. Backoff is exponential (default 3 attempts, base 500 ms, factor 2, ±25% jitter) with `Retry-After` honoured (both `delta-seconds` and HTTP-date forms). Override per-client:

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

Mutating endpoints accept an optional `Idempotency-Key` header, which is forwarded to the server for its own deduplication. The SDK does not treat this header as permission to replay `POST` or `PATCH`.

```typescript
const tp = '3029d415-d0a6-4710-a9c1-8cb063ef872f';

await client.mt4.patchUserRecordLogin(
  tp,
  817542,
  { comment: 'updated comment' },
  { 'idempotency-key': 'my-request-id-12345' },
);
```

The server may return a cached response for a repeated key within its configured window; this is independent of the SDK transport retry policy.

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
