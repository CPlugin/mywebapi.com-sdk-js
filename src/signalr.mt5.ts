// SignalR client for the MT5 v2 hub at `/hubs/mt5/v2`.
//
// `@microsoft/signalr` is an **optional peer dependency** — consumers who only
// use the REST surface don't need to install it. This file imports the package
// lazily at construction time and surfaces a clear error if it isn't available.
//
// * MT5 v2 exposes a reduced real-time scope vs MT4: only connection status
//   callbacks and the margin-call stream. This matches the live hub contract in
//   `WebAPI/Hubs/MT5/v2/MT5V2Hub.cs`.

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
import { type SignalRClientExtras, MT4V2SignalRError } from './signalr';

// * --- Payload types (server contract) ---------------------------------------------
// * Names and shapes mirror `WebAPI/Hubs/MT5/v2/MT5V2Payloads.cs` exactly.

export interface MT5ConnectionStatusPayload {
  connected: boolean;
}

export interface MT5MarginCallPayload {
  login:     number;
  type:      string;
  direction: string;
}

// * --- Options type ----------------------------------------------------------------
//
// * MT5V2SignalRClientOptions reuses MT4V2ClientOptions as the base union (same
//   credential shapes: token / clientCredentials) and adds the injected-provider
//   branch for use through CPluginWebApiClient.realtime. SignalRClientExtras adds
//   the optional hubUrl / logger / reconnect overrides.
//
// * The union is declared with the injected-provider branch as a standalone member
//   rather than as an intersection with MT4V2ClientOptions branches, because
//   TypeScript cannot narrow a union member from the inner union — we need the
//   full `tradePlatform` field to be present in all branches; MT4V2ClientOptions
//   already carries it; the injected branch adds it explicitly.

export type MT5V2SignalRClientOptions =
  | ({ tokenProvider: TokenProvider; baseUrl: string; tradePlatform: string } & SignalRClientExtras)
  | (MT4V2ClientOptions & SignalRClientExtras);

// * --- Client class ----------------------------------------------------------------

/**
 * SignalR wrapper around `/hubs/mt5/v2`. Holds a single `HubConnection` and
 * exposes typed helpers for the MT5 reduced real-time scope.
 *
 * Lifecycle:
 * 1. `new MT5V2SignalRClient(opts)` — synchronous; resolves the token provider
 *    and pre-computes the hub URL but does NOT open a socket.
 * 2. Register callbacks via `onConnectionStatus()` — MAY be called before
 *    `start()`. Registering before `start()` is recommended so the initial
 *    post-handshake `OnConnectionStatus` push is never missed.
 * 3. `await client.start()` — opens the WebSocket connection. All callbacks
 *    queued before `start()` are attached to the `HubConnection` before the
 *    socket opens, guaranteeing they are in place before any server push arrives.
 * 4. Use `streamMarginCallUpdates()` to consume streams (requires open connection).
 * 5. `await client.stop()` — closes the connection.
 */
export class MT5V2SignalRClient {
  private readonly hubUrl:        string;
  private readonly tokenProvider: TokenProvider;
  private readonly reconnect:     number[] | false;
  private readonly logger?:       unknown;

  private connection:      HubConnection | null                      = null;
  // * Pending handler registrations queued before start() is called.
  // *   Drained onto the HubConnection in start(), BEFORE conn.start() so that
  // *   every callback is in place before the server can push any message.
  private pendingHandlers: Array<(conn: HubConnection) => void>      = [];

  constructor(opts: MT5V2SignalRClientOptions) {
    if (!opts.tradePlatform)
      throw new MT4V2SignalRError('tradePlatform is required');
    if (!opts.baseUrl)
      throw new MT4V2SignalRError('baseUrl is required');

    // * Resolve token provider — three branches in priority order:
    // *   1. Injected provider from CPluginWebApiClient.realtime — reuse its token
    // *      cache directly. No second OAuth round-trip needed.
    // *   2. Static token string — wrap in StaticTokenProvider.
    // *   3. Client-credentials tuple — build a new ClientCredentialsTokenProvider.
    if ('tokenProvider' in opts && opts.tokenProvider) {
      // * Shared provider injected by CPluginWebApiClient — reuse its token cache.
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

    // * Build the hub URL with tradePlatform query parameter pre-baked.
    const b   = opts.hubUrl ?? `${opts.baseUrl.replace(/\/+$/, '')}/hubs/mt5/v2`;
    const sep = b.includes('?') ? '&' : '?';
    this.hubUrl   = `${b}${sep}tradePlatform=${encodeURIComponent(opts.tradePlatform)}`;

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

    const signalR  = await this.loadSignalRModule();
    const Builder  = signalR.HubConnectionBuilder as new () => HubConnectionBuilderType;
    const LogLevel = signalR.LogLevel;

    let builder = new Builder()
      .withUrl(this.hubUrl, {
        accessTokenFactory: () => this.tokenProvider.getToken(),
      });

    if (this.reconnect !== false) {
      builder = builder.withAutomaticReconnect(this.reconnect);
    }

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

  // * --- Callback-style helpers -------------------------------------------------------

  /** Subscribe to `OnConnectionStatus` callbacks. The server pushes one such
   *  event right after the handshake completes.
   *  May be called before or after `start()` — registering before `start()` is
   *  strongly recommended to avoid missing the initial post-handshake push. */
  onConnectionStatus(handler: (payload: MT5ConnectionStatusPayload) => void): void {
    this.register(c => c.on('OnConnectionStatus', handler));
  }

  // * --- Stream-style helpers --------------------------------------------------------

  /** Returns an `AsyncIterable<MT5MarginCallPayload>` backed by the server-side
   *  `StreamMarginCallUpdates` stream. Use in a `for await` loop. */
  streamMarginCallUpdates(): AsyncIterable<MT5MarginCallPayload> {
    return this.toAsyncIterable<MT5MarginCallPayload>(
      this.getConnection().stream('StreamMarginCallUpdates'),
    );
  }

  /** Bridge `IStreamResult<T>` (push-based) → `AsyncIterable<T>` (pull-based).
   *  Backpressure: SignalR buffers in memory; if the consumer is slower than the
   *  producer the buffer grows. Caller can `break` out of the `for await` loop to
   *  cancel the underlying server-side stream. */
  private toAsyncIterable<T>(stream: IStreamResult<T>): AsyncIterable<T> {
    return {
      [Symbol.asyncIterator]() {
        const queue:  T[]                                       = [];
        let   waiter: ((v: IteratorResult<T>) => void) | null  = null;
        let   error:  unknown                                   = null;
        let   done                                              = false;

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
