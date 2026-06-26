// SignalR client for the MT4 v2 hub at `/hubs/mt4/v2`.
//
// `@microsoft/signalr` is an **optional peer dependency** — consumers who only use
// the REST surface don't need to install it. This file imports the package lazily
// at construction time and surfaces a clear error if it isn't available.
//
// Why a sibling class instead of bolting onto `MT4V2Client`:
//   - SignalR holds a long-lived `HubConnection` object and a reconnect loop;
//     the REST client is stateless. Mixing the two lifecycles makes the REST
//     client harder to dispose and harder to test.
//   - Consumers who want only one transport pay only for that transport's
//     dependency surface.
//   - Both clients accept the same `MT4V2ClientOptions` shape, so a typical
//     application constructs the REST one first, then passes the SAME options
//     object into `MT4V2SignalRClient` — token cache is shared via the provider.

import type {
  HubConnection,
  HubConnectionBuilder as HubConnectionBuilderType,
  IStreamResult,
} from '@microsoft/signalr';
import {
  type ClientCredentialsOptions,
  ClientCredentialsTokenProvider,
  StaticTokenProvider,
  type TokenProvider,
} from './auth';
import type { MT4V2ClientOptions } from './client';

// * --- Payload types (server contract) ---------------------------------------------
// * Names and shapes mirror `WebAPI/Hubs/MT4/v2/MT4V2Payloads.cs` exactly.

export interface ConnectionStatusPayload {
  connected: boolean;
}

export interface TickPayload {
  symbol: string;
  bid: number;
  ask: number;
  /** ISO-8601 string when serialised over the wire; SignalR's JSON protocol
   * does not auto-revive `Date`. Parse on the consumer side if needed. */
  lastTime: string | null;
}

export interface MarginCallPayload {
  login: number;
  group: string | null;
  leverage: number;
  updated: number;
  balance: number;
  equity: number;
  volumeLots: number;
  margin: number;
  free: number;
  level: number;
  controllingType: number;
  levelType: number;
}

export type TradeUpdateKind = 'Added' | 'Updated' | 'Deleted';

export interface TradeUpdatePayload {
  kind: TradeUpdateKind;
  order: number;
  login: number;
  symbol: string;
  cmd: number;
  volumeLots: number;
  openPrice: number;
  openTime: string;
  sl: number;
  tp: number;
  closePrice: number;
  closeTime: string;
  commission: number;
  storage: number;
  profit: number;
  taxes: number;
  comment: string;
}

export type UserUpdateKind = 'Added' | 'Updated' | 'Deleted';

export interface UserUpdatePayload {
  kind: UserUpdateKind;
  login: number;
  group: string;
  name: string;
  country: string;
  leverage: number;
  balance: number;
  credit: number;
  enabled: boolean;
  readOnly: boolean;
  regDate: string;
  lastDate: string;
  email: string;
  phone: string;
  comment: string;
}

export type SymbolUpdateKind = 'Added' | 'Updated' | 'Deleted';

export interface SymbolUpdatePayload {
  kind: SymbolUpdateKind;
  symbol: string;
  description: string;
  currency: string;
  digits: number;
  tradeMode: number;
  spread: number;
  stopsLevel: number;
  freezeLevel: number;
  contractSize: number;
  tickValue: number;
  tickSize: number;
  marginInitial: number;
  marginMaintenance: number;
}

// * --- Options & errors ------------------------------------------------------------

/** SignalR-specific overrides layered on top of the REST-client options shape. */
export interface SignalRClientExtras {
  /** Defaults to `${baseUrl}/hubs/mt4/v2`. Override only for non-standard deployments. */
  hubUrl?: string;
  /** Optional logger sink — same shape `@microsoft/signalr` accepts.
   * Pass `LogLevel.Information` from the package, or any object with a `log(level, message)` method. */
  logger?: unknown;
  /** Reconnect intervals in milliseconds. Pass `false` to disable auto-reconnect.
   * Default: `[0, 2000, 10_000, 30_000]` then give up. */
  reconnect?: number[] | false;
}

// * MT4V2ClientOptions is a discriminated union (`{token}` vs `{clientId,…}`);
// *   TypeScript forbids `interface extends` on union types, so we union the
// *   intersection of each branch with the extras.
// *
// * Three option branches exist:
// *   1. `{ tokenProvider, baseUrl }` — injected provider (shared from CPluginWebApiClient).
// *      Checked FIRST so the SDK's cached provider takes priority over the legacy forms.
// *   2. `{ token }` — static bearer string.
// *   3. `{ clientId, clientSecret, identityUrl }` — client-credentials flow.
// *
// * All branches additionally accept `SignalRClientExtras` (hubUrl override, logger, reconnect).
export type MT4V2SignalRClientOptions =
  | ({ tokenProvider: TokenProvider; baseUrl: string; tradePlatform: string } & SignalRClientExtras)
  | (MT4V2ClientOptions & SignalRClientExtras);

export class MT4V2SignalRError extends Error {
  constructor(message: string, public readonly cause?: unknown) {
    super(message);
    this.name = 'MT4V2SignalRError';
  }
}

// * --- Client class ----------------------------------------------------------------

/**
 * SignalR wrapper around `/hubs/mt4/v2`. Holds a single `HubConnection` and exposes
 * typed stream helpers.
 *
 * Lifecycle:
 * 1. `new MT4V2SignalRClient(opts)` — synchronous; resolves the token provider and
 *    pre-computes the hub URL but does NOT open a socket.
 * 2. Register callbacks via `onConnectionStatus()` / `onTick()` — MAY be called
 *    before `start()`. Registering before `start()` is recommended so no early
 *    server push (e.g. the post-handshake `OnConnectionStatus`) is missed.
 * 3. `await client.start()` — opens the connection. Auth token is fetched via the
 *    provider's `getToken()`; `tradePlatform` is appended to the URL. All callbacks
 *    queued before `start()` are attached to the `HubConnection` before the socket
 *    opens, guaranteeing they are in place before any server push arrives.
 * 4. Use `streamTicks()` / `streamMarginCallUpdates()` / etc. to consume server
 *    streams. Each helper returns an `AsyncIterable<T>` for easy `for await` use.
 *    Stream helpers require an open connection — call them after `start()`.
 * 5. `await client.stop()` — closes the connection.
 */
export class MT4V2SignalRClient {
  private readonly hubUrl:        string;
  private readonly tokenProvider: TokenProvider;
  private readonly reconnect:     number[] | false;
  private readonly logger?:       unknown;

  private connection:      HubConnection | null                      = null;
  // * Pending handler registrations queued before start() is called.
  // *   Drained onto the HubConnection in start(), BEFORE conn.start() so that
  // *   every callback is in place before the server can push any message.
  private pendingHandlers: Array<(conn: HubConnection) => void>      = [];

  constructor(opts: MT4V2SignalRClientOptions) {
    if (!opts.tradePlatform)
      throw new MT4V2SignalRError('tradePlatform is required');
    if (!opts.baseUrl)
      throw new MT4V2SignalRError('baseUrl is required');

    // * Resolve token provider — three branches in priority order:
    // *   1. Injected provider from CPluginWebApiClient.realtime — reuse its token cache directly.
    // *   2. Static token string — wrap in StaticTokenProvider.
    // *   3. Client-credentials tuple — build a new ClientCredentialsTokenProvider.
    if ('tokenProvider' in opts && opts.tokenProvider) {
      // * Shared provider injected by CPluginWebApiClient — reuse its token cache.
      //   No second OAuth round-trip; both REST and SignalR share the same cached bearer.
      this.tokenProvider = opts.tokenProvider;
    } else if ('token' in opts && opts.token) {
      this.tokenProvider = new StaticTokenProvider(opts.token);
    } else if ('clientId' in opts && 'clientSecret' in opts && 'identityUrl' in opts) {
      const cco: ClientCredentialsOptions = {
        clientId:     opts.clientId,
        clientSecret: opts.clientSecret,
        identityUrl:  opts.identityUrl,
        ...(opts.scopes ? { scopes: opts.scopes } : {}),
      };
      this.tokenProvider = new ClientCredentialsTokenProvider(cco);
    } else {
      throw new MT4V2SignalRError(
        'opts must include either `tokenProvider`, `token`, or { clientId, clientSecret, identityUrl }');
    }

    // * Build the hub URL with tradePlatform query parameter pre-baked. SignalR
    // *   will additionally append `access_token=…` for WebSocket negotiate — the
    // *   server accepts that under the standard JwtBearer events pipeline.
    const base = opts.hubUrl ?? `${opts.baseUrl.replace(/\/+$/, '')}/hubs/mt4/v2`;
    const sep  = base.includes('?') ? '&' : '?';
    this.hubUrl =
      `${base}${sep}tradePlatform=${encodeURIComponent(opts.tradePlatform)}`;

    this.reconnect = opts.reconnect ?? [0, 2_000, 10_000, 30_000];
    this.logger    = opts.logger;
  }

  // * --- Handler registration queue ------------------------------------------------

  /** Register a handler on the connection.
   *  - If the connection already exists (i.e. `start()` has been called), the
   *    handler is applied immediately.
   *  - Otherwise it is pushed onto `pendingHandlers` and applied in `start()`
   *    BEFORE the socket opens, guaranteeing no server push is missed. */
  private register(fn: (conn: HubConnection) => void): void {
    if (this.connection) {
      fn(this.connection);
    } else {
      this.pendingHandlers.push(fn);
    }
  }

  // * --- Test / diagnostic accessors -----------------------------------------------
  // * These expose internal state for unit tests and debugging. They are read-only
  // *   and carry no production overhead beyond the property lookup itself.

  /** The resolved hub URL including the `tradePlatform` query parameter.
   *  Intended for tests and diagnostic tooling. */
  get hubUrlForTest(): string { return this.hubUrl; }

  /** Resolve a token via this client's token provider.
   *  Intended for tests to verify that the shared provider is wired correctly. */
  tokenForTest(): Promise<string> { return this.tokenProvider.getToken(); }

  // * ---------------------------------------------------------------------------------

  /** Lazy-load `@microsoft/signalr`. Throws a clear error if the peer dep is missing. */
  private async loadSignalRModule(): Promise<typeof import('@microsoft/signalr')> {
    try {
      return await import('@microsoft/signalr');
    } catch (e) {
      throw new MT4V2SignalRError(
        '`@microsoft/signalr` peer dependency is not installed. ' +
        'Run `npm install @microsoft/signalr` (or `bun add @microsoft/signalr`) and retry.',
        e);
    }
  }

  /** Open the SignalR connection. Idempotent — calling twice while already
   *  connected resolves without action. */
  async start(): Promise<void> {
    if (this.connection?.state === 'Connected') return;

    const signalR    = await this.loadSignalRModule();
    const Builder    = signalR.HubConnectionBuilder as new () => HubConnectionBuilderType;
    const LogLevel   = signalR.LogLevel;

    let builder = new Builder()
      .withUrl(this.hubUrl, {
        accessTokenFactory: () => this.tokenProvider.getToken(),
      });

    if (this.reconnect !== false) {
      builder = builder.withAutomaticReconnect(this.reconnect);
    }

    // * Configure logger if provided; default to Warning level to keep the
    // *   client quiet in production.
    if (this.logger !== undefined) {
      builder = builder.configureLogging(this.logger as never);
    } else {
      builder = builder.configureLogging(LogLevel.Warning);
    }

    const conn = builder.build();
    this.connection = conn;

    // * Drain any handlers registered before start() was called.
    // ! This MUST happen before conn.start() so every callback is attached to
    // !   the HubConnection before the WebSocket handshake completes and the
    // !   server can push its post-handshake OnConnectionStatus message.
    for (const fn of this.pendingHandlers) fn(conn);
    this.pendingHandlers = [];

    // * The server always pushes OnConnectionStatus right after the handshake.
    //   Register a default sink so stream-only consumers (who never call
    //   onConnectionStatus) don't trigger a "no client method" warning. A
    //   user-registered onConnectionStatus handler runs in addition to this
    //   (SignalR invokes all handlers registered for a method).
    conn.on('OnConnectionStatus', () => { /* default sink */ });

    await conn.start();
  }

  /** Close the SignalR connection. Safe to call on a connection that was never
   *  started or has already been closed. */
  async stop(): Promise<void> {
    if (!this.connection) return;
    await this.connection.stop();
    this.connection = null;
  }

  /** Returns the underlying `HubConnection` for advanced use (manual `.on`/`.invoke`
   *  calls not covered by the typed helpers below). Throws if not started yet. */
  getConnection(): HubConnection {
    if (!this.connection)
      throw new MT4V2SignalRError('SignalR client not started — call start() first');
    return this.connection;
  }

  // * --- Callback-style ticks ----------------------------------------------------

  /** Subscribe to `OnTick` callbacks. Pair with `subscribeToTicks(symbol)`.
   *  May be called before or after `start()` — registering before is recommended
   *  so no early server push is missed. */
  onTick(handler: (payload: TickPayload) => void): void {
    this.register(c => c.on('OnTick', handler));
  }

  /** Subscribe to `OnConnectionStatus` callbacks. The server pushes one such
   *  event right after the handshake completes.
   *  May be called before or after `start()` — registering before `start()` is
   *  strongly recommended to avoid missing the initial post-handshake push. */
  onConnectionStatus(handler: (payload: ConnectionStatusPayload) => void): void {
    this.register(c => c.on('OnConnectionStatus', handler));
  }

  /** Subscribe the connection to a per-symbol tick stream. Server will push
   *  `OnTick` callbacks for every tick of that symbol until unsubscribed. */
  async subscribeToTicks(symbol: string): Promise<void> {
    await this.getConnection().invoke('SubscribeToTicks', symbol);
  }

  async unsubscribeFromTicks(symbol: string): Promise<void> {
    await this.getConnection().invoke('UnsubscribeFromTicks', symbol);
  }

  // * --- Stream-style helpers ----------------------------------------------------

  /** Returns an `AsyncIterable<TickPayload>`. When `symbol` is omitted, every
   *  symbol's ticks flow through. */
  streamTicks(symbol?: string): AsyncIterable<TickPayload> {
    const conn = this.getConnection();
    const args = symbol !== undefined ? [symbol] : [];
    return this.toAsyncIterable<TickPayload>(conn.stream('StreamTicks', ...args));
  }

  streamMarginCallUpdates(): AsyncIterable<MarginCallPayload> {
    const conn = this.getConnection();
    return this.toAsyncIterable<MarginCallPayload>(conn.stream('StreamMarginCallUpdates'));
  }

  streamTrades(): AsyncIterable<TradeUpdatePayload> {
    const conn = this.getConnection();
    return this.toAsyncIterable<TradeUpdatePayload>(conn.stream('StreamTrades'));
  }

  streamUserUpdates(): AsyncIterable<UserUpdatePayload> {
    const conn = this.getConnection();
    return this.toAsyncIterable<UserUpdatePayload>(conn.stream('StreamUserUpdates'));
  }

  streamSymbolUpdates(): AsyncIterable<SymbolUpdatePayload> {
    const conn = this.getConnection();
    return this.toAsyncIterable<SymbolUpdatePayload>(conn.stream('StreamSymbolUpdates'));
  }

  /** Bridge `IStreamResult<T>` (push-based) → `AsyncIterable<T>` (pull-based).
   *  Backpressure: the SignalR client buffers in memory; if the consumer is
   *  slower than the producer the buffer grows. Caller can `break` out of the
   *  `for await` loop to cancel the underlying server-side stream. */
  private toAsyncIterable<T>(stream: IStreamResult<T>): AsyncIterable<T> {
    return {
      [Symbol.asyncIterator]() {
        const queue:    T[]                                                = [];
        let   waiter:   ((v: IteratorResult<T>) => void) | null            = null;
        let   error:    unknown                                            = null;
        let   done                                                          = false;

        const sub = stream.subscribe({
          next: (item) => {
            if (waiter) { const w = waiter; waiter = null; w({ value: item, done: false }); }
            else queue.push(item);
          },
          complete: () => {
            done = true;
            if (waiter) { const w = waiter; waiter = null; w({ value: undefined as never, done: true }); }
          },
          error: (e) => {
            error = e;
            done  = true;
            if (waiter) { const w = waiter; waiter = null; w({ value: undefined as never, done: true }); }
          },
        });

        return {
          next(): Promise<IteratorResult<T>> {
            if (error) return Promise.reject(error);
            if (queue.length) return Promise.resolve({ value: queue.shift()!, done: false });
            if (done) return Promise.resolve({ value: undefined as never, done: true });
            return new Promise<IteratorResult<T>>((resolve) => { waiter = resolve; });
          },
          return(): Promise<IteratorResult<T>> {
            // * Caller broke out of the for-await loop — cancel the server stream.
            try { sub.dispose(); } catch { /* best effort */ }
            done = true;
            return Promise.resolve({ value: undefined as never, done: true });
          },
        };
      },
    };
  }
}
