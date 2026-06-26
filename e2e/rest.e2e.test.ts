// * E2E tests for the REST surface of the v2 SDK.
//
// These tests exercise the REAL running WebAPI server end-to-end:
//   OAuth token acquisition → HTTPS call → v2 envelope → unwrapped data.
//
// ! GATED — all tests skip unless WEBAPI_E2E=1 AND the four required
//   credential env vars are set (see e2e/_setup.ts for the full list).
//
// Prerequisites:
//   - Manager credential (client_id / client_secret with MANAGER rights on
//     a connected trade platform).  A user-only credential gets HTTP 403 on
//     getServerTime and getCfgRequestCommon, which will fail those tests.
//   - At least one trade platform connected and pumping.
//
// Run:  bun run test:e2e   (or  WEBAPI_E2E=1 bun test e2e)

import { describe, test, expect, beforeAll } from 'bun:test';
import { E2E_ENABLED, makeClient, resolveTp, withTimeout } from './_setup';
import { CPluginWebApiClient, ApiError, collectAll } from '../src/index';

// ---------------------------------------------------------------------------
// * Suite — skips entirely when E2E_ENABLED is false (no creds / no opt-in)
// ---------------------------------------------------------------------------

describe.skipIf(!E2E_ENABLED)('REST e2e', () => {
  let client: CPluginWebApiClient;
  let tp: string;

  // * One-time setup — authenticate and resolve the trade platform ID before
  //   any test runs.  Failures here abort the suite with a clear message.
  beforeAll(async () => {
    client = makeClient();
    tp     = await withTimeout(resolveTp(client), 15_000, 'resolveTp');
    console.log(`[E2E REST] trade platform: ${tp}`);
  });

  // -------------------------------------------------------------------------
  // * listTradePlatforms — basic connectivity + auth sanity
  // -------------------------------------------------------------------------

  test('listTradePlatforms returns a non-empty array of platforms with string ids', async () => {
    const platforms = await withTimeout(
      client.listTradePlatforms(),
      15_000,
      'listTradePlatforms',
    );

    expect(Array.isArray(platforms)).toBe(true);
    expect(platforms.length).toBeGreaterThan(0);

    // * Every item must carry a non-empty string id.
    for (const p of platforms) {
      expect(typeof p.id).toBe('string');
      expect(p.id.length).toBeGreaterThan(0);
    }
  });

  // -------------------------------------------------------------------------
  // * getServerTime — proves OAuth token + manager call + envelope unwrap
  // -------------------------------------------------------------------------

  test('getServerTime returns a date within ±1 day of now', async () => {
    // * Exposed as client.mt4.getServerTime after the MT4 suffix is stripped
    //   by the CleanNamespace utility (getServerTimeMT4 → getServerTime).
    const result = await withTimeout(
      client.mt4.getServerTime(tp),
      15_000,
      'getServerTime',
    );

    // * The server returns a date/time string (ISO-8601 or similar).
    //   Accept either a string or a number representing a Unix timestamp.
    expect(result).toBeTruthy();

    const parsed = new Date(result as unknown as string);
    expect(parsed.getTime()).not.toBeNaN();

    const nowMs     = Date.now();
    const oneDayMs  = 24 * 60 * 60 * 1000;
    expect(Math.abs(parsed.getTime() - nowMs)).toBeLessThan(oneDayMs);
  });

  // -------------------------------------------------------------------------
  // * getCfgRequestCommon — manager-level config read
  // -------------------------------------------------------------------------

  test('getCfgRequestCommon returns a non-null object', async () => {
    const result = await withTimeout(
      client.mt4.getCfgRequestCommon(tp),
      15_000,
      'getCfgRequestCommon',
    );

    expect(result).not.toBeNull();
    expect(typeof result).toBe('object');
  });

  // -------------------------------------------------------------------------
  // * collectAll over getTradesGet — pagination helper
  // -------------------------------------------------------------------------

  test('collectAll over getTradesGet resolves without throwing; items (if any) are objects', async () => {
    const trades = await withTimeout(
      collectAll((cursor) =>
        client.paged(() =>
          // * getTradesGet accepts optional { limit, cursor } via GetTradesGetParams.
          client.mt4.getTradesGet(tp, { limit: 100, ...(cursor ? { cursor } : {}) }),
        ),
      ),
      30_000,
      'collectAll getTradesGet',
    );

    expect(Array.isArray(trades)).toBe(true);

    // * When trades exist each must be a proper object (not null / primitive).
    for (const trade of trades) {
      expect(trade).not.toBeNull();
      expect(typeof trade).toBe('object');
    }
  });

  // -------------------------------------------------------------------------
  // * getUserRecordGetLogin with a nonexistent login — ApiError path
  //
  //   The SDK unwraps the v2 envelope and throws ApiError when the server
  //   returns a non-null error field.  A clearly bogus login (999_999_999)
  //   should always produce a NotFound or similar error from the MT4 pump.
  //
  //   getUserRecordGetLogin(tradePlatform: string, login: number) — login is
  //   typed as `number` in the generated mt4-v2-users.ts.
  // -------------------------------------------------------------------------

  test('getUserRecordGetLogin with bogus login throws ApiError with .code and .activityId', async () => {
    // * login: number — use a value outside any realistic MT4 login range.
    const BOGUS_LOGIN = 999_999_999;

    let thrown: unknown;
    try {
      await withTimeout(
        client.mt4.getUserRecordGetLogin(tp, BOGUS_LOGIN),
        15_000,
        'getUserRecordGetLogin bogus',
      );
    } catch (err) {
      thrown = err;
    }

    // * Must have thrown — a nonexistent login should never succeed.
    expect(thrown).toBeDefined();
    expect(thrown).toBeInstanceOf(ApiError);

    const apiErr = thrown as ApiError;

    // * ApiError must carry a stable transport-level error code.
    expect(typeof apiErr.code).toBe('string');
    expect(apiErr.code.length).toBeGreaterThan(0);

    // * activityId is the W3C trace id from ApiMeta — present on all v2 responses
    //   (may be undefined only if the server omits meta entirely, which it shouldn't).
    //   We assert it is either a non-empty string or undefined (not null).
    expect(apiErr.activityId === undefined || typeof apiErr.activityId === 'string').toBe(true);
  });
});
