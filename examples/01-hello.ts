// * Example 01 — Hello: discover platforms, authenticate, and read server state.
//
// * Need credentials? Create API keys and manage trade platforms in the Toolbox:
// *   staging: https://pre.toolbox.cplugin.com   ·   prod: https://toolbox.cplugin.com
//
// Demonstrates the minimal setup needed to use the SDK:
//   1. Build a CPluginWebApiClient from env vars (OAuth2 client-credentials flow).
//   2. Call resolveTradePlatform() — auto-selects the platform when you have exactly
//      one; lists all options and exits when you have several (set WEBAPI_TRADE_PLATFORM).
//   3. Call ServerTime — proves the token was acquired and the server responded
//      via the v2 envelope.
//   4. Call CfgRequestCommon — proves the manager connection is live and returns
//      structured broker metadata (server name, build, timezone).
//
// Run:
//   bun examples/01-hello.ts
//
// Required env vars (bun auto-loads .env in the project root):
//   WEBAPI_BASE_URL      — e.g. https://pre.mywebapi.com
//   WEBAPI_AUTH_SERVER   — e.g. https://pre.auth.cplugin.net
//   WEBAPI_CLIENT_ID     — OAuth2 client_id
//   WEBAPI_CLIENT_SECRET — OAuth2 client_secret
//
// Optional:
//   WEBAPI_TRADE_PLATFORM — trade platform GUID; auto-selected if you have exactly one,
//                           required if you have several (the script lists them for you).

import { ApiError } from '../src/index';
import { buildClientFromEnv, resolveTradePlatform } from './_shared';

// ---------------------------------------------------------------------------
// * Construct the client — single object per process; token is cached internally
//   and refreshed automatically before it expires (ClientCredentialsTokenProvider).
// ---------------------------------------------------------------------------
const client = buildClientFromEnv();

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
async function main(): Promise<void> {
  console.log('=== WebAPI v2 SDK — Example 01: Hello ===\n');
  console.log(`API base : ${process.env['WEBAPI_BASE_URL'] ?? ''}`);
  console.log('');

  // * --- Platform discovery --------------------------------------------------
  // resolveTradePlatform() calls GET /api/TradePlatforms and either picks the
  // one platform automatically or asks the user to choose from the list.
  // The returned id is what every MT4/MT5 endpoint expects as tradePlatform.
  const tp = await resolveTradePlatform(client);
  console.log('');

  // * --- Step 1: ServerTime ---------------------------------------------------
  // ServerTime is the SDK smoke-test: it exercises the full OAuth2 + HTTP +
  // v2-envelope pipeline with the cheapest possible call (no manager work).
  // If this succeeds, auth + network are both functional.
  console.log('--- ServerTime ---');
  try {
    const serverTime = await client.mt4.getServerTime(tp);
    // * The client unwraps the v2 envelope — `serverTime` is the inner value
    //   (a date/time string from the trade server clock).
    console.log(`Server time: ${String(serverTime)}`);
  } catch (err) {
    if (err instanceof ApiError) {
      // * ApiError carries structured fields: code (WebApiErrorCode), description,
      //   activityId (W3C trace id for log correlation), and managerCode (raw MT4 code).
      console.error(`API error [${err.code}]: ${err.description ?? err.message}`);
      if (err.activityId) console.error(`  Activity ID: ${err.activityId}`);
    } else {
      // ! A non-ApiError here usually means a network or OAuth2 problem.
      console.error('Unexpected error:', err);
    }
    process.exit(1);
  }

  // * --- Step 2: CfgRequestCommon --------------------------------------------
  // Returns broker metadata from the live manager connection (not pump cache).
  // Fields: name (server name), owner (broker name), build, version, timeZone.
  console.log('\n--- CfgRequestCommon ---');
  try {
    const common = await client.mt4.getCfgRequestCommon(tp);
    // * `common` is typed as MT4Common — access fields directly, no envelope unwrap needed.
    console.log(`Server name  : ${common?.name     ?? '(none)'}`);
    console.log(`Owner        : ${common?.owner    ?? '(none)'}`);
    console.log(`Build        : ${common?.build    ?? '?'}`);
    console.log(`Version      : ${common?.version  ?? '?'}`);
    console.log(`Time zone    : UTC${(common?.timeZone ?? 0) >= 0 ? '+' : ''}${common?.timeZone ?? 0}`);
  } catch (err) {
    if (err instanceof ApiError) {
      console.error(`API error [${err.code}]: ${err.description ?? err.message}`);
      if (err.activityId) console.error(`  Activity ID: ${err.activityId}`);
    } else {
      console.error('Unexpected error:', err);
    }
    process.exit(1);
  }

  console.log('\nAll checks passed.');
}

main().catch((err: unknown) => {
  console.error('Fatal:', err);
  process.exit(1);
});
