// * Example 02 — Live Prices: subscribe to real-time tick stream via SignalR.
//
// * Need credentials? Create API keys and manage trade platforms in the Toolbox:
// *   staging: https://pre.toolbox.cplugin.com   ·   prod: https://toolbox.cplugin.com
//
// Demonstrates the SDK's real-time layer (MT4 v2 SignalR hub):
//   1. Obtain a MT4V2SignalRClient from client.realtime.mt4(tp) — this reuses
//      the same cached OAuth2 token as the REST namespace (no second login).
//   2. Open the WebSocket connection with rt.start().
//   3. Iterate ticks with `for await (const tick of rt.streamTicks(symbol))`.
//      Each TickPayload carries: symbol, bid, ask, lastTime.
//   4. Break the loop on Ctrl-C and stop the connection cleanly.
//
// Peer dependency required (already in package.json devDependencies):
//   bun add @microsoft/signalr   (or: npm install @microsoft/signalr)
//
// Run:
//   bun examples/02-live-prices.ts
//
// Required env vars (bun auto-loads .env in the project root):
//   WEBAPI_BASE_URL       — API server base URL
//   WEBAPI_AUTH_SERVER    — OAuth2 authority URL
//   WEBAPI_CLIENT_ID      — OAuth2 client_id
//   WEBAPI_CLIENT_SECRET  — OAuth2 client_secret
//
// Optional:
//   WEBAPI_TRADE_PLATFORM — trade platform GUID; auto-selected if you have exactly one,
//                           required if you have several (set it to one of the listed IDs).
//   WEBAPI_SYMBOL         — symbol to subscribe to (default: EURUSD)

import { ApiError, type TickPayload } from '../src/index';
import { buildClientFromEnv, resolveTradePlatform } from './_shared';

// * Optional: override the symbol via env; default to EURUSD (always quoted on most MT4 servers).
const symbol = process.env['WEBAPI_SYMBOL'] ?? 'EURUSD';

// ---------------------------------------------------------------------------
// * Construct the REST+SignalR client.
// ---------------------------------------------------------------------------
const client = buildClientFromEnv();

// ---------------------------------------------------------------------------
// * Format a tick as a compact terminal line.
// ---------------------------------------------------------------------------
function formatTick(tick: TickPayload): string {
  // * lastTime arrives as an ISO-8601 string or null; display it compactly.
  const time = tick.lastTime ? new Date(tick.lastTime).toISOString() : '—';
  const bid  = tick.bid  != null ? tick.bid.toFixed(5)  : '—';
  const ask  = tick.ask  != null ? tick.ask.toFixed(5)  : '—';
  return `[${time}]  ${tick.symbol ?? symbol}  bid=${bid}  ask=${ask}`;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
async function main(): Promise<void> {
  console.log('=== WebAPI v2 SDK — Example 02: Live Prices ===\n');

  // * Resolve which trade platform to use. Auto-selects when exactly one exists;
  //   requires WEBAPI_TRADE_PLATFORM when several are present.
  const tp = await resolveTradePlatform(client);

  console.log(`Platform : ${tp}`);
  console.log(`Symbol   : ${symbol}`);
  console.log('Press Ctrl-C to stop.\n');

  // * Obtain the real-time client. client.realtime.mt4(tp) constructs a
  //   MT4V2SignalRClient that shares the same token provider as the REST
  //   namespace — no separate OAuth2 handshake needed.
  const rt = client.realtime.mt4(tp);

  // * Flag used by the SIGINT handler to break the tick loop without throwing.
  let stopping = false;

  // * Register a clean-shutdown handler so Ctrl-C closes the WebSocket
  //   before the process exits (avoids hanging server-side subscriptions).
  process.on('SIGINT', () => {
    if (stopping) { process.exit(1); } // ! second Ctrl-C → hard exit (tick loop may be stalled)
    stopping = true;
    console.log('\nStopping…');
    // ? rt.stop() is async — we call it and let the finally block below await it.
  });

  try {
    // * Open the SignalR connection — this performs the WebSocket negotiate
    //   handshake and acquires the access token via the shared provider.
    console.log('Connecting to SignalR hub…');
    await rt.start();
    console.log('Connected. Streaming ticks…\n');

    // * streamTicks(symbol) returns an AsyncIterable<TickPayload>.
    //   The server streams one message per tick received by its pump.
    //   Breaking out of the for-await loop cancels the server-side stream.
    for await (const tick of rt.streamTicks(symbol)) {
      console.log(formatTick(tick));

      // * Check the stopping flag here so the loop exits on the next tick
      //   after Ctrl-C rather than waiting for the async SIGINT handler.
      if (stopping) break;
    }
  } catch (err) {
    if (err instanceof ApiError) {
      console.error(`API error [${err.code}]: ${err.description ?? err.message}`);
    } else if (!stopping) {
      // ! Only re-throw if we were not intentionally stopping; otherwise the
      //   SignalR close triggers a benign "connection closed" error.
      console.error('Stream error:', err);
      process.exitCode = 1;
    }
  } finally {
    // * Always close the WebSocket, regardless of how we got here.
    await rt.stop();
    console.log('Connection closed.');
  }
}

main().catch((err: unknown) => {
  console.error('Fatal:', err);
  process.exit(1);
});
