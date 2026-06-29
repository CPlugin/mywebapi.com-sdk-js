# @mywebapi.com/sdk

TypeScript client for the CPlugin WebAPI v2 — a management API for trading-platform servers.

**Status:** Published on the public npm registry as [`@mywebapi.com/sdk`](https://www.npmjs.com/package/@mywebapi.com/sdk) (early access, current version `0.1.0`). The API shape is stable; while the package is at `0.x`, minor releases may introduce breaking changes, so pin a version in production. Versioning follows [semver](https://semver.org/).

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
  env: 'prod',  // or 'staging' or { baseUrl, authUrl }
  clientId: 'your-client-id',
  clientSecret: process.env.CPLUGIN_WEBAPI_CLIENT_SECRET!,
});

// MT4 server time
const tp = '3029d415-d0a6-4710-a9c1-8cb063ef872f';
const time = await client.mt4.getServerTime(tp);
console.log('MT4 server time:', time.data.timestamp);

// MT5 server time
const mt5Time = await client.mt5.getServerTime(tp);
console.log('MT5 server time:', mt5Time.data.timestamp);

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

### From environment variables

`CPluginWebApiClient.fromEnvironment()` builds a client from `CPLUGIN_WEBAPI_ENV` (or `CPLUGIN_WEBAPI_BASE_URL` + `CPLUGIN_WEBAPI_AUTH_URL`), `CPLUGIN_WEBAPI_CLIENT_ID`, and `CPLUGIN_WEBAPI_CLIENT_SECRET`. Missing variables raise an `Error` that names the missing key.

```typescript
const client = CPluginWebApiClient.fromEnvironment();
const tp = process.env.CPLUGIN_WEBAPI_TRADE_PLATFORM!;
const time = await client.mt4.getServerTime(tp);
```

### Static token (advanced / testing)

For scenarios with a pre-issued JWT (CI fixtures, short-lived service-account tokens, test rigs), pass a `token` instead of `clientId` / `clientSecret`. No refresh is performed — when the token expires, the API returns errors.

```typescript
const client = new CPluginWebApiClient({
  env: 'prod',
  token: 'eyJhbGc...',
});

const tp = '3029d415-d0a6-4710-a9c1-8cb063ef872f';
const time = await client.mt4.getServerTime(tp);
```

## Retries

Idempotent requests retry automatically on transient errors (`429`, `502`, `503`, `504`, and `408`). Retry-eligible:

- `GET` and `HEAD` — always idempotent per HTTP spec.
- `POST` / `PATCH` / `PUT` / `DELETE` — only when you supply an `Idempotency-Key` header via method options.

Backoff is exponential (default 3 attempts, base 500 ms, factor 2, ±25% jitter) with `Retry-After` honoured (both `delta-seconds` and HTTP-date forms). Override per-client:

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

Mutating endpoints (POST / PATCH / PUT / DELETE) accept an optional `Idempotency-Key` header for safe retries. Pass it in the options object:

```typescript
const tp = '3029d415-d0a6-4710-a9c1-8cb063ef872f';

await client.mt4.patchUserRecordLogin(
  tp,
  817542,
  { comment: 'updated comment' },
  { 'idempotency-key': 'my-request-id-12345' },
);
```

Any string ≤255 chars is valid. Two calls with the same key within the server's `cacheTimeout` window return the cached response. Supplying a key also marks the request as idempotent for the retry layer, enabling automatic retry on transient failures.

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
bun run fetch-spec    # download swagger.json from running WebAPI (WEBAPI_BASE_URL env)
bun run generate      # regenerate src/generated/api.d.ts
bun run typecheck

# Integration tests against the live WebAPI — needs env vars (or a .env file):
#   WEBAPI_BASE_URL, WEBAPI_AUTH_SERVER, WEBAPI_CLIENT_ID, WEBAPI_CLIENT_SECRET,
#   WEBAPI_TRADE_PLATFORM, WEBAPI_KNOWN_LOGIN
bun run test

bun run build         # outputs dist/index.js + dist/*.d.ts
```

## SignalR (real-time streams)

Real-time streaming is **built into this package** — there is no separate SignalR package. The only extra is the optional peer dependency `@microsoft/signalr`, installed **only if you use real-time** (the REST surface works without it):

```sh
bun add @microsoft/signalr   # or: npm install @microsoft/signalr
```

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

MT4 hubs expose ticks, trades, margin-call, user and symbol streams; MT5 hubs expose connection status and margin-call updates.

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
