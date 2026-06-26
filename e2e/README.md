# E2E Test Suite — @cplugin/saas-webapi-client

End-to-end tests that exercise the **real running WebAPI** server: OAuth token acquisition, REST v2 envelope unwrapping, `ApiError` propagation, pagination, and SignalR tick streaming.

## Quick start

```bash
# 1. Copy and fill in your manager credentials
cp clients/typescript/.env.example clients/typescript/.env   # create if needed

# 2. Populate .env (gitignored — never commit this file)
WEBAPI_E2E=1
WEBAPI_BASE_URL=https://pre.mywebapi.com
WEBAPI_AUTH_SERVER=https://pre.auth.cplugin.net
WEBAPI_CLIENT_ID=my-manager-client
WEBAPI_CLIENT_SECRET=secret-here

# 3. Run
cd clients/typescript
bun run test:e2e
```

## Environment variables

### Required

| Variable | Example | Description |
|---|---|---|
| `WEBAPI_E2E` | `1` | Opt-in flag — must be exactly `1` to enable the suite |
| `WEBAPI_BASE_URL` | `https://pre.mywebapi.com` | WebAPI base URL (no trailing slash) |
| `WEBAPI_AUTH_SERVER` | `https://pre.auth.cplugin.net` | Identity server (OAuth2 authority) |
| `WEBAPI_CLIENT_ID` | `my-client` | OAuth2 `client_id` |
| `WEBAPI_CLIENT_SECRET` | `secret` | OAuth2 `client_secret` |

### Optional

| Variable | Default | Description |
|---|---|---|
| `WEBAPI_TRADE_PLATFORM` | *(auto)* | Trade platform ID — auto-selected when there is exactly one, required when multiple exist |
| `WEBAPI_SYMBOL` | `EURUSD` | Symbol used for SignalR tick streaming test |
| `WEBAPI_E2E_TICK_TIMEOUT_MS` | `20000` | Deadline (ms) for the first tick to arrive |

## What is tested

### `rest.e2e.test.ts`

| Test | What it proves |
|---|---|
| `listTradePlatforms` | OAuth token works; discovery endpoint reachable; returns `{ id: string }[]` |
| `getServerTime` | Manager credential valid; MT4 call goes through; envelope → `data` unwrapped; date sanity |
| `getCfgRequestCommon` | Manager-level config read succeeds and returns a non-null object |
| `collectAll` over `getTradesGet` | Pagination helper works end-to-end (cursor loop terminates cleanly) |
| `getUserRecordGetLogin` bogus login | SDK throws `ApiError` with `.code` + `.activityId` on a server-side error |

### `signalr.e2e.test.ts`

| Test | What it proves |
|---|---|
| `start()` + `onConnectionStatus` | WebSocket handshake succeeds; server pushes `OnConnectionStatus` |
| `streamTicks(symbol)` | AsyncIterable tick stream delivers a tick with `{ symbol, bid, ask }` |

## Notes

- **Manager rights required**: `getServerTime`, `getCfgRequestCommon`, and `getTradesGet` require a credential with MANAGER permissions on the connected platform.  A user-only credential returns HTTP 403 and the tests will fail.
- **Active price feed required** for the tick streaming test.  On a closed market or a platform with no live prices the test will time out.  Extend `WEBAPI_E2E_TICK_TIMEOUT_MS` if the feed is slow.
- **`@microsoft/signalr`** must be installed (it is a devDependency — `bun install` covers it).  If missing, `rt.start()` throws a clear error from the SDK.
- The `.env` file is gitignored.  Never commit credentials.
- All E2E tests `skipIf(!E2E_ENABLED)`.  Running `bun test` without `WEBAPI_E2E=1` produces only skipped tests — never failures.
