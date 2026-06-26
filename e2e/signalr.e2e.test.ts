// * E2E tests for the SignalR real-time surface of the v2 SDK.
//
// Tests the full lifecycle: OAuth token → WebSocket handshake → server push.
//
// ! GATED — all tests skip unless WEBAPI_E2E=1 AND the four required
//   credential env vars are set (see e2e/_setup.ts for the full list).
//
// Prerequisites:
//   - @microsoft/signalr devDependency must be installed (`bun install`).
//     If missing, `rt.start()` throws a clear error from the SDK.
//   - Manager credential with access to a connected, pumping trade platform.
//   - An active price feed on the chosen symbol for the tick test.
//     Closed market / no feed → the tick test will time out.  Set
//     WEBAPI_E2E_TICK_TIMEOUT_MS (default 20 000 ms) if the feed is slow.
//
// Run:  bun run test:e2e   (or  WEBAPI_E2E=1 bun test e2e)

import { describe, test, expect, beforeAll } from 'bun:test';
import { E2E_ENABLED, makeClient, resolveTp, withTimeout, SYMBOL, TICK_TIMEOUT_MS } from './_setup';
import { CPluginWebApiClient } from '../src/index';
import type { MT4V2SignalRClient } from '../src/signalr';

// ---------------------------------------------------------------------------
// * Suite — skips entirely when E2E_ENABLED is false (no creds / no opt-in)
// ---------------------------------------------------------------------------

describe.skipIf(!E2E_ENABLED)('SignalR e2e', () => {
  let client: CPluginWebApiClient;
  let tp: string;

  // * One-time setup — shared across both SignalR tests.
  beforeAll(async () => {
    client = makeClient();
    tp     = await withTimeout(resolveTp(client), 15_000, 'resolveTp (SignalR)');
    console.log(`[E2E SignalR] trade platform: ${tp}  symbol: ${SYMBOL}`);
  }, 20_000);

  // -------------------------------------------------------------------------
  // * Connection lifecycle — start() succeeds and server pushes OnConnectionStatus
  // -------------------------------------------------------------------------

  test('start() connects and onConnectionStatus callback fires within 5 s', async () => {
    const rt: MT4V2SignalRClient = client.realtime.mt4(tp);

    // * Register the callback BEFORE start() — the race-free pattern.
    //   The handler is queued internally and attached to the HubConnection
    //   before the WebSocket handshake opens, so the server's immediate
    //   post-handshake OnConnectionStatus push is never missed.
    const statusReceived = new Promise<void>((resolve) => {
      rt.onConnectionStatus((_payload) => resolve());
    });

    try {
      await rt.start();
      await withTimeout(statusReceived, 5_000, 'onConnectionStatus callback');
    } finally {
      await rt.stop();
    }
    // ! Bun's per-test timeout defaults to 5 s; raise it above the internal
    //   withTimeout so THAT governs, not Bun's default.
  }, 15_000);

  // -------------------------------------------------------------------------
  // * Tick streaming — first tick arrives within TICK_TIMEOUT_MS
  //
  //   ! This test requires an active price feed.  On a closed market or
  //     a platform without live prices it will fail with a timeout.
  //     Use WEBAPI_E2E_TICK_TIMEOUT_MS to extend the deadline.
  // -------------------------------------------------------------------------

  test(`streamTicks(${SYMBOL}) receives first tick within ${TICK_TIMEOUT_MS} ms`, async () => {
    const rt: MT4V2SignalRClient = client.realtime.mt4(tp);

    let tickError: unknown;

    const firstTick = new Promise<{ symbol: string; bid: number; ask: number }>(
      async (resolve, reject) => {
        try {
          await rt.start();

          // * Subscribe to the symbol tick stream BEFORE iterating so the server
          //   starts sending OnTick events for this symbol.
          await rt.subscribeToTicks(SYMBOL);

          // * streamTicks returns an AsyncIterable<TickPayload> — take the first item.
          for await (const tick of rt.streamTicks(SYMBOL)) {
            resolve(tick);
            break;
          }
        } catch (err) {
          reject(err);
        }
      },
    );

    try {
      const tick = await withTimeout(
        firstTick,
        TICK_TIMEOUT_MS,
        `first tick for ${SYMBOL} (check that the market is open and the price feed is active)`,
      );

      // * Validate tick shape: symbol must match, bid/ask must be positive numbers.
      expect(tick.symbol).toBe(SYMBOL);
      expect(typeof tick.bid).toBe('number');
      expect(tick.bid).toBeGreaterThan(0);
      expect(typeof tick.ask).toBe('number');
      expect(tick.ask).toBeGreaterThan(0);
    } catch (err) {
      tickError = err;
    } finally {
      // ! Always close the connection — even on timeout or assertion failure.
      await rt.stop();
    }

    if (tickError) throw tickError;
    // ! Bun's per-test timeout (default 5 s) must exceed the internal tick
    //   deadline (TICK_TIMEOUT_MS) or Bun kills the test before it can wait.
  }, TICK_TIMEOUT_MS + 10_000);
});
