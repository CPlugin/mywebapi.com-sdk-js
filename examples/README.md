# SDK Examples — v2 Trading Terminal

Three progressive examples showing how to use the `@cplugin/saas-webapi-client` SDK.
Each builds on the previous one, adding a new capability.

> **WARNING — Example 03 with `--live`**
> Running `bun examples/03-trading-terminal.ts --live` places **real market orders**
> on the configured MT4 trade server. Only do this against a demo or test account.
> The default dry-run mode is safe and prints the request body without sending anything.

---

## Prerequisites

```bash
# From the clients/typescript directory:
bun install              # installs devDependencies including @microsoft/signalr
```

`@microsoft/signalr` is a peer dependency required by examples 02 and 03.
It is already listed in `devDependencies`; `bun install` covers it.
If you use a stripped install, add it explicitly:

```bash
bun add @microsoft/signalr
```

---

## Getting started (minimal friction)

You need **credentials only** — no manual platform lookup required.

```bash
cp .env.example .env
# Fill in WEBAPI_CLIENT_ID and WEBAPI_CLIENT_SECRET
# Staging URLs are already set — no other changes needed
bun examples/01-hello.ts
```

What happens on first run:

- **One trade platform** on your account → it is selected automatically; you will see `Auto-selected your only trade platform: <id> (<name>)`. Examples 02 and 03 work identically.
- **Multiple trade platforms** → the script lists every platform with its ID, name, and type, then exits. Set `WEBAPI_TRADE_PLATFORM=<id>` in your `.env` and re-run.
- **No trade platforms** → a message explains how to create one in the Toolbox (staging https://pre.toolbox.cplugin.com · prod https://toolbox.cplugin.com).

---

## Environment variables

Configuration is templated in `clients/typescript/.env.example`. To set up:

```bash
cp .env.example .env
# then edit .env and fill in your credentials
```

The template defaults to **staging** (the safe choice for development). Uncomment the prod block to target production.

Your `.env` file is gitignored and will never be committed. `.env.example` is committed so others can copy it as a starting template.

### Environment options

**Staging (default, already uncommented):**

```dotenv
WEBAPI_BASE_URL=https://pre.mywebapi.com
WEBAPI_AUTH_SERVER=https://pre.auth.cplugin.net
```

**Production (uncomment the block in `.env.example` to use):**

```dotenv
WEBAPI_BASE_URL=https://cloud.mywebapi.com
WEBAPI_AUTH_SERVER=https://auth.cplugin.net
```

### Required credentials

Create API keys (client ID and client secret) in the **Toolbox**:
- **Staging:** https://pre.toolbox.cplugin.com
- **Production:** https://toolbox.cplugin.com

Fill in `WEBAPI_CLIENT_ID` and `WEBAPI_CLIENT_SECRET` with the credentials from the Toolbox. Both are required.

### Optional variables

- `WEBAPI_TRADE_PLATFORM` — Platform GUID. **Auto-selected when you have exactly one platform.** Set this explicitly only if you have multiple platforms and want to pick a specific one. Manage platforms in the Toolbox (links above).
- `WEBAPI_SYMBOL` — Symbol to trade (default: `EURUSD`).

All examples exit with a clear error message if a required variable is missing or if manual platform selection is needed.

---

## Example 01 — Hello (`01-hello.ts`)

**What it shows:** Platform auto-selection via `resolveTradePlatform()`, OAuth2 auth, REST calls, v2 envelope unwrapping.

Calls three endpoints in order:

- `GET /api/TradePlatforms` — resolves the active platform (auto-select if one, require explicit choice if many).
- `ServerTime` — smoke-test that exercises the full auth + HTTP + envelope pipeline.
- `CfgRequestCommon` — reads live broker metadata (server name, build, timezone).

```bash
# Works with credentials only — platform is auto-selected if you have exactly one:
bun examples/01-hello.ts

# Pin a specific platform when you have several:
WEBAPI_TRADE_PLATFORM=<guid> bun examples/01-hello.ts
```

---

## Example 02 — Live Prices (`02-live-prices.ts`)

**What it shows:** SignalR real-time connection, tick streaming, clean shutdown.

Opens a WebSocket to the MT4 v2 hub (`/hubs/mt4/v2`), subscribes to tick updates
for the configured symbol, and prints each tick as it arrives.
Press **Ctrl-C** to stop; the connection is closed gracefully.

```bash
bun examples/02-live-prices.ts

# Override symbol:
WEBAPI_SYMBOL=USDJPY bun examples/02-live-prices.ts
```

---

## Example 03 — Trading Terminal (`03-trading-terminal.ts`)

**What it shows:** Background tick stream + open trades list + full order lifecycle.

1. Starts the live price stream in the background (prints ticks alongside the log).
2. Fetches all open trades using `collectAll` + cursor pagination.
3. Opens a market Buy order at the current ask price.
4. Closes the same order at the current bid price.

**Dry-run (default — no orders placed):**

```bash
bun examples/03-trading-terminal.ts
```

This prints the exact JSON body each trade request would send, then exits.

**Live mode — places REAL orders:**

```bash
bun examples/03-trading-terminal.ts --live
```

Only use `--live` on a demo/test MT4 server. The volume defaults to 10 internal units
(0.1 lot). Override with `WEBAPI_VOLUME` if needed.

---

## Type-checking

```bash
cd clients/typescript
bunx tsc --noEmit -p examples/tsconfig.json
```

Expected: 0 errors.

---

## Running the SDK test suite

```bash
cd clients/typescript
bun test
```
