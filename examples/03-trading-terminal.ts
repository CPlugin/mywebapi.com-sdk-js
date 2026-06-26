// * Example 03 — Trading Terminal: live prices + open trades + order lifecycle.
//
// * Need credentials? Create API keys and manage trade platforms in the Toolbox:
// *   staging: https://pre.toolbox.cplugin.com   ·   prod: https://toolbox.cplugin.com
//
// The full loop demonstrating both read and write paths:
//   1. Stream live tick prices for a symbol in the background.
//   2. List all currently open trades (paged fetch, flattened via collectAll).
//   3. Open a market order (Buy) at the current ask price.
//   4. Close the same order at the current bid price.
//
// ! ORDER SAFETY — DRY-RUN BY DEFAULT:
//   Without the `--live` argument the script prints the exact request body
//   it WOULD send and exits WITHOUT placing any real orders.
//   Only run with `--live` when connected to a test/demo broker server
//   and you are prepared to accept a real position.
//
// Run (dry-run — safe):
//   bun examples/03-trading-terminal.ts
//
// Run (LIVE — places real orders!):
//   bun examples/03-trading-terminal.ts --live
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
//   WEBAPI_SYMBOL         — symbol to trade (default: EURUSD)
//   WEBAPI_VOLUME         — volume in MT4 internal units (default: 10 = 0.1 lot)
//                           1 lot = 100 units; keep this small on a real server!

import {
  ApiError,
  collectAll,
  type TickPayload,
} from '../src/index';
import type { MT4TradeTransaction } from '../src/generated/model/mT4TradeTransaction';
import { buildClientFromEnv, resolveTradePlatform } from './_shared';

// * Optional env vars resolved at module level (no async needed).
const symbol = process.env['WEBAPI_SYMBOL'] ?? 'EURUSD';

// * Volume in MT4 internal units (1 lot = 100). Default 10 = 0.1 lot.
//   Override via WEBAPI_VOLUME if you need a different size.
const volumeRaw = process.env['WEBAPI_VOLUME'] ?? '10';
const volume = parseInt(volumeRaw, 10);
if (isNaN(volume) || volume <= 0) {
  console.error(`WEBAPI_VOLUME must be a positive integer (got: "${volumeRaw}")`);
  process.exit(1);
}

// * Dry-run is the default. The --live flag must be explicitly passed to place real orders.
const isLive = process.argv.includes('--live');

// ---------------------------------------------------------------------------
// * Construct the client.
// ---------------------------------------------------------------------------
const client = buildClientFromEnv();

// ---------------------------------------------------------------------------
// * Tick tracker — background goroutine feeds latest bid/ask here so the
//   main flow can read the price at order time without blocking.
// ---------------------------------------------------------------------------
interface LatestPrice {
  bid: number;
  ask: number;
  updatedAt: string;
}

let latestPrice: LatestPrice | null = null;

// * streamPrices runs the SignalR tick loop in the background.
//   It writes to latestPrice on every tick and resolves the `ready` promise
//   when the first tick arrives (so main() can wait for a known-good price).
async function streamPrices(
  tp: string,
  onFirstTick: () => void,
  stopSignal: () => boolean,
): Promise<void> {
  const rt = client.realtime.mt4(tp);
  try {
    await rt.start();
    let firstSeen = false;
    for await (const tick of rt.streamTicks(symbol)) {
      if (tick.bid != null && tick.ask != null) {
        latestPrice = {
          bid: tick.bid,
          ask: tick.ask,
          updatedAt: tick.lastTime ?? new Date().toISOString(),
        };
        if (!firstSeen) {
          firstSeen = true;
          onFirstTick();
        }
        // * Print each tick so the terminal shows the live feed alongside
        //   the main workflow steps below.
        process.stdout.write(
          `  tick  ${symbol}  bid=${tick.bid.toFixed(5)}  ask=${tick.ask.toFixed(5)}\n`,
        );
      }
      if (stopSignal()) break;
    }
  } finally {
    await rt.stop();
  }
}

// ---------------------------------------------------------------------------
// * Helper: wait for the first tick or time out after `ms` milliseconds.
//   Avoids blocking the main flow indefinitely if the server sends no ticks.
// ---------------------------------------------------------------------------
function waitForFirstTick(timeout: number): { ready: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const ready = new Promise<void>((res, rej) => {
    resolve = res;
    setTimeout(() => rej(new Error(`No tick received within ${timeout}ms — is the platform pumping?`)), timeout);
  });
  return { ready, resolve };
}

// ---------------------------------------------------------------------------
// * Open a market order. Returns the ticket number assigned by the server.
//   price = current ask for a Buy; the server may adjust for spread.
// ---------------------------------------------------------------------------
async function openMarketOrder(tp: string, ask: number): Promise<number> {
  const body: MT4TradeTransaction = {
    tradeTransactionType: 'OpenMarket',
    tradeCommand: 'Buy',        // * Buy at market — filled at ask price.
    symbol,
    volume,
    price: ask,                 // * Hint price; server replaces with live quote.
    sl: 0,                      // * No stop-loss for this example order.
    tp: 0,                      // * No take-profit.
    comment: 'sdk-example-03',  // * Broker-visible comment; helps trace test orders.
  };

  if (!isLive) {
    // * DRY-RUN: show what would be sent without touching the server.
    console.log('\n[DRY-RUN] Would POST TradeTransaction (OpenMarket):');
    console.log(JSON.stringify(body, null, 2));
    console.log('\nRe-run with --live to place the actual order.');
    return 0; // * Sentinel ticket for dry-run.
  }

  // * The Idempotency-Key header is STRONGLY recommended for trade mutations.
  //   A unique key per logical order prevents double-execution on HTTP retry.
  //   Here we generate a per-run key; in production use a stable request UUID.
  const idempotencyKey = crypto.randomUUID();

  const result = await client.mt4.postTradeTransaction(tp, body, {
    headers: { 'Idempotency-Key': idempotencyKey },
  });

  // * The response echoes the mutated MT4TradeTransaction. On OpenMarket the
  //   `order` field is populated with the new ticket number.
  const ticket = result?.order;
  if (!ticket) throw new Error('Server returned no order ticket after OpenMarket');
  return ticket;
}

// ---------------------------------------------------------------------------
// * Close a position by ticket number.
// ---------------------------------------------------------------------------
async function closeMarketOrder(tp: string, ticket: number, bid: number): Promise<void> {
  const body: MT4TradeTransaction = {
    tradeTransactionType: 'CloseMarket',
    tradeCommand: 'Sell',       // * Closing a Buy requires a Sell command.
    symbol,
    volume,
    price: bid,                 // * Hint price; server replaces with live quote.
    order: ticket,              // ! Must supply the original ticket to identify the position.
    sl: 0,
    tp: 0,
    comment: 'sdk-example-03-close',
  };

  if (!isLive) {
    console.log('\n[DRY-RUN] Would POST TradeTransaction (CloseMarket):');
    console.log(JSON.stringify(body, null, 2));
    return;
  }

  const idempotencyKey = crypto.randomUUID();
  await client.mt4.postTradeTransaction(tp, body, {
    headers: { 'Idempotency-Key': idempotencyKey },
  });
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
async function main(): Promise<void> {
  console.log('=== WebAPI v2 SDK — Example 03: Trading Terminal ===\n');

  // * Resolve which trade platform to use. Auto-selects when exactly one exists;
  //   requires WEBAPI_TRADE_PLATFORM when several are present.
  const tp = await resolveTradePlatform(client);

  console.log(`Platform : ${tp}`);
  console.log(`Symbol   : ${symbol}`);
  console.log(`Volume   : ${volume} units (${(volume / 100).toFixed(2)} lots)`);
  console.log(`Mode     : ${isLive ? '*** LIVE — REAL ORDERS ***' : 'DRY-RUN (safe, pass --live to place real orders)'}\n`);

  // * --- Step 1: Start the background price stream ---------------------------
  //   The stream goroutine fills `latestPrice` continuously while the main
  //   workflow proceeds. We wait for the first tick before trading so we have
  //   a fresh bid/ask.
  let shouldStop = false;
  const { ready, resolve: notifyFirstTick } = waitForFirstTick(15_000);

  // * Launch the tick loop without awaiting — it runs concurrently with main().
  const priceStreamDone = streamPrices(tp, notifyFirstTick, () => shouldStop).catch((err: unknown) => {
    // * Don't crash the main flow on a stream error; just log it.
    console.error('Tick stream error:', err);
  });

  // * --- Step 2: List open trades (paged fetch) --------------------------------
  //   collectAll walks all pages automatically using the cursor from each
  //   response's meta.paging field. For servers with many positions, use
  //   `paginate()` instead to process one page at a time.
  console.log('Fetching open trades…');
  try {
    const trades = await collectAll((cursor) =>
      client.paged(() =>
        client.mt4.getTradesGet(tp, {
          limit: 100,
          ...(cursor != null ? { cursor } : {}),
        }),
      ),
    );

    console.log(`Open positions: ${trades.length}`);
    // * Print the first 5 to give a feel of the data without flooding the terminal.
    for (const t of trades.slice(0, 5)) {
      // * TradeRecord fields vary; use optional chaining defensively.
      const anyT = t as Record<string, unknown>;
      console.log(
        `  #${String(anyT['order'] ?? '?')}  ${String(anyT['symbol'] ?? '?')}` +
        `  vol=${String(anyT['volume'] ?? '?')}  profit=${String(anyT['profit'] ?? '?')}`,
      );
    }
    if (trades.length > 5) console.log(`  … and ${trades.length - 5} more`);
  } catch (err) {
    if (err instanceof ApiError) {
      console.error(`API error fetching trades [${err.code}]: ${err.description ?? err.message}`);
    } else {
      throw err;
    }
  }

  // * --- Step 3: Wait for the first tick so we have a fresh price ---------------
  console.log('\nWaiting for first tick…');
  try {
    await ready;
    console.log(`Price received: bid=${latestPrice!.bid.toFixed(5)}  ask=${latestPrice!.ask.toFixed(5)}`);
  } catch (err) {
    console.error('Could not get tick:', (err as Error).message);
    shouldStop = true;
    await priceStreamDone;
    process.exit(1);
  }

  // * --- Step 4: Open a market order (or print dry-run request) -----------------
  console.log('\n--- Opening market order ---');
  let ticket = 0;
  try {
    ticket = await openMarketOrder(tp, latestPrice!.ask);
    if (isLive) {
      console.log(`Order opened: ticket #${ticket}`);
    }
  } catch (err) {
    if (err instanceof ApiError) {
      console.error(`Trade error [${err.code}]: ${err.description ?? err.message}`);
      if (err.activityId) console.error(`  Activity ID: ${err.activityId}`);
    } else {
      throw err;
    }
  }

  // * --- Step 5: Close the order (live only) -------------------------------------
  if (isLive && ticket > 0) {
    // * Brief pause to let the server process the open before the close arrives.
    //   On a real desk you would wait for a signal or user action instead.
    await Bun.sleep(500);

    console.log('\n--- Closing market order ---');
    try {
      await closeMarketOrder(tp, ticket, latestPrice!.bid);
      console.log(`Order #${ticket} closed.`);
    } catch (err) {
      if (err instanceof ApiError) {
        console.error(`Trade close error [${err.code}]: ${err.description ?? err.message}`);
      } else {
        throw err;
      }
    }
  }

  if (!isLive) {
    // * Dry-run complete — no server state was modified.
    console.log('\n[DRY-RUN] Script finished without touching the trade server.');
  } else {
    console.log('\nTrading sequence complete.');
  }

  // * Stop the background tick stream and wait for it to finish cleanly.
  shouldStop = true;
  await priceStreamDone;
}

main().catch((err: unknown) => {
  console.error('Fatal:', err);
  process.exit(1);
});
