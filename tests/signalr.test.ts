// Unit tests for the SignalR client. We mock `@microsoft/signalr` at the module
// boundary so we never open a real socket — the goal is to verify our wiring
// (URL construction, token factory, stream invocation, async-iterator bridge),
// not the underlying SignalR library.

import { afterEach, describe, expect, mock, test } from 'bun:test';
// ! SignalR is out of scope for the public SDK (B2). Import directly from the
//   source module — index.ts does not re-export it until B6.
import {
  MT4V2SignalRClient,
  MT4V2SignalRError,
} from '../src/signalr';
import { MT5V2SignalRClient } from '../src/signalr.mt5';

// * --- Stub @microsoft/signalr -------------------------------------------------

interface StreamSubscriber<T> {
  next: (item: T) => void;
  complete: () => void;
  error: (e: unknown) => void;
}

interface StreamResult<T> {
  subscribe(s: StreamSubscriber<T>): { dispose(): void };
}

class FakeStreamResult<T> implements StreamResult<T> {
  private subscriber: StreamSubscriber<T> | null = null;
  disposed = false;
  subscribe(s: StreamSubscriber<T>) {
    this.subscriber = s;
    return { dispose: () => { this.disposed = true; } };
  }
  emit(item: T) { this.subscriber?.next(item); }
  complete()    { this.subscriber?.complete(); }
  fail(e: unknown) { this.subscriber?.error(e); }
}

class FakeHubConnection {
  state = 'Disconnected';
  startCalls = 0;
  stopCalls  = 0;
  invokes:  Array<{ method: string; args: unknown[] }> = [];
  streams:  Array<{ method: string; args: unknown[]; stream: FakeStreamResult<unknown> }> = [];
  handlers: Record<string, (...args: unknown[]) => void> = {};

  async start() { this.startCalls++; this.state = 'Connected'; }
  async stop()  { this.stopCalls++;  this.state = 'Disconnected'; }
  on(event: string, handler: (...args: unknown[]) => void) { this.handlers[event] = handler; }
  async invoke(method: string, ...args: unknown[]) { this.invokes.push({ method, args }); }
  stream<T>(method: string, ...args: unknown[]): StreamResult<T> {
    const s = new FakeStreamResult<T>();
    this.streams.push({ method, args, stream: s as FakeStreamResult<unknown> });
    return s;
  }
}

let lastBuilder: FakeHubConnectionBuilder | null = null;
let lastConnection: FakeHubConnection | null = null;

class FakeHubConnectionBuilder {
  url:                 string | null                                          = null;
  accessTokenFactory:  (() => string | Promise<string>) | null                 = null;
  reconnectIntervals:  number[] | undefined                                    = undefined;
  loggerCfg:           unknown                                                 = undefined;
  constructor() { lastBuilder = this; }
  withUrl(url: string, opts?: { accessTokenFactory?: () => string | Promise<string> }) {
    this.url                = url;
    this.accessTokenFactory = opts?.accessTokenFactory ?? null;
    return this;
  }
  withAutomaticReconnect(intervals?: number[]) { this.reconnectIntervals = intervals; return this; }
  configureLogging(level: unknown)             { this.loggerCfg          = level;     return this; }
  build(): FakeHubConnection {
    lastConnection = new FakeHubConnection();
    return lastConnection;
  }
}

const FakeLogLevel = { Trace: 0, Debug: 1, Information: 2, Warning: 3, Error: 4, Critical: 5, None: 6 };

mock.module('@microsoft/signalr', () => ({
  HubConnectionBuilder: FakeHubConnectionBuilder,
  LogLevel:             FakeLogLevel,
}));

afterEach(() => {
  lastBuilder    = null;
  lastConnection = null;
});

// * --- Constructor validation -------------------------------------------------

describe('MT4V2SignalRClient — construction', () => {
  test('throws when tradePlatform is missing', () => {
    // The type still accepts empty string; we exercise the runtime guard.
    expect(() => new MT4V2SignalRClient({
      baseUrl: 'http://localhost:5002',
      tradePlatform: '',
      token: 'eyJ.fake.token',
    })).toThrow(MT4V2SignalRError);
  });

  test('throws when baseUrl is missing', () => {
    expect(() => new MT4V2SignalRClient({
      baseUrl: '',
      tradePlatform: '00000000-0000-0000-0000-000000000001',
      token: 'eyJ.fake.token',
    })).toThrow(MT4V2SignalRError);
  });

  test('throws when neither token nor client_credentials options are supplied', () => {
    // Cast away type safety — exercising the runtime branch that catches a
    // caller who passes an object missing both discriminator branches.
    const opts = {
      baseUrl: 'http://localhost:5002',
      tradePlatform: '00000000-0000-0000-0000-000000000001',
    } as unknown as ConstructorParameters<typeof MT4V2SignalRClient>[0];
    expect(() => new MT4V2SignalRClient(opts)).toThrow(MT4V2SignalRError);
  });

  test('accepts static-token options', () => {
    const c = new MT4V2SignalRClient({
      baseUrl: 'http://localhost:5002',
      tradePlatform: '00000000-0000-0000-0000-000000000001',
      token: 'eyJ.fake.token',
    });
    expect(c).toBeInstanceOf(MT4V2SignalRClient);
  });

  test('accepts client_credentials options', () => {
    const c = new MT4V2SignalRClient({
      baseUrl: 'http://localhost:5002',
      tradePlatform: '00000000-0000-0000-0000-000000000001',
      clientId: 'cid',
      clientSecret: 'csec',
      identityUrl: 'https://identity.example/',
    });
    expect(c).toBeInstanceOf(MT4V2SignalRClient);
  });
});

// * --- start() / URL construction --------------------------------------------

describe('MT4V2SignalRClient — start()', () => {
  test('builds default hub URL from baseUrl', async () => {
    const c = new MT4V2SignalRClient({
      baseUrl: 'http://localhost:5002',
      tradePlatform: '11111111-2222-3333-4444-555555555555',
      token: 'eyJ.fake.token',
    });
    await c.start();
    expect(lastBuilder?.url).toBe(
      'http://localhost:5002/hubs/mt4/v2?tradePlatform=11111111-2222-3333-4444-555555555555');
    expect(lastConnection?.startCalls).toBe(1);
  });

  test('respects explicit hubUrl override', async () => {
    const c = new MT4V2SignalRClient({
      baseUrl: 'http://localhost:5002',
      tradePlatform: '11111111-2222-3333-4444-555555555555',
      token: 'eyJ.fake.token',
      hubUrl: 'https://api.example/mt4hub',
    });
    await c.start();
    expect(lastBuilder?.url).toBe(
      'https://api.example/mt4hub?tradePlatform=11111111-2222-3333-4444-555555555555');
  });

  test('appends tradePlatform with `&` when hubUrl already has a query', async () => {
    const c = new MT4V2SignalRClient({
      baseUrl: 'http://localhost:5002',
      tradePlatform: '11111111-2222-3333-4444-555555555555',
      token: 'eyJ.fake.token',
      hubUrl: 'https://api.example/mt4hub?x=1',
    });
    await c.start();
    expect(lastBuilder?.url).toBe(
      'https://api.example/mt4hub?x=1&tradePlatform=11111111-2222-3333-4444-555555555555');
  });

  test('accessTokenFactory yields the static token', async () => {
    const c = new MT4V2SignalRClient({
      baseUrl: 'http://localhost:5002',
      tradePlatform: '11111111-2222-3333-4444-555555555555',
      token: 'eyJ.fake.static.token',
    });
    await c.start();
    const tok = await lastBuilder!.accessTokenFactory!();
    expect(tok).toBe('eyJ.fake.static.token');
  });

  test('default reconnect intervals are wired', async () => {
    const c = new MT4V2SignalRClient({
      baseUrl: 'http://localhost:5002',
      tradePlatform: '11111111-2222-3333-4444-555555555555',
      token: 'eyJ.fake.token',
    });
    await c.start();
    expect(lastBuilder?.reconnectIntervals).toEqual([0, 2_000, 10_000, 30_000]);
  });

  test('reconnect=false disables auto-reconnect', async () => {
    const c = new MT4V2SignalRClient({
      baseUrl: 'http://localhost:5002',
      tradePlatform: '11111111-2222-3333-4444-555555555555',
      token: 'eyJ.fake.token',
      reconnect: false,
    });
    await c.start();
    expect(lastBuilder?.reconnectIntervals).toBeUndefined();
  });

  test('start() is idempotent', async () => {
    const c = new MT4V2SignalRClient({
      baseUrl: 'http://localhost:5002',
      tradePlatform: '11111111-2222-3333-4444-555555555555',
      token: 'eyJ.fake.token',
    });
    await c.start();
    await c.start();
    expect(lastConnection?.startCalls).toBe(1);
  });
});

// * --- Stream helpers --------------------------------------------------------

describe('MT4V2SignalRClient — streams', () => {
  test('streamTicks() invokes server method with symbol arg', async () => {
    const c = new MT4V2SignalRClient({
      baseUrl: 'http://localhost:5002',
      tradePlatform: '11111111-2222-3333-4444-555555555555',
      token: 'eyJ.fake.token',
    });
    await c.start();

    const iter = c.streamTicks('EURUSD')[Symbol.asyncIterator]();
    // Touch the stream once to trigger subscription via the iterator's first .next()
    const pendingNext = iter.next();
    // Find the stream and emit a tick
    const s = lastConnection!.streams.find(x => x.method === 'StreamTicks');
    expect(s).toBeDefined();
    expect(s!.args).toEqual(['EURUSD']);
    s!.stream.emit({ symbol: 'EURUSD', bid: 1.1, ask: 1.2, lastTime: null });
    const first = await pendingNext;
    expect(first).toEqual({ value: { symbol: 'EURUSD', bid: 1.1, ask: 1.2, lastTime: null }, done: false });
  });

  test('streamTicks() with no symbol invokes server method with no args', async () => {
    const c = new MT4V2SignalRClient({
      baseUrl: 'http://localhost:5002',
      tradePlatform: '11111111-2222-3333-4444-555555555555',
      token: 'eyJ.fake.token',
    });
    await c.start();
    // Trigger the subscription via asyncIterator
    c.streamTicks()[Symbol.asyncIterator]().next();
    const s = lastConnection!.streams.find(x => x.method === 'StreamTicks');
    expect(s!.args).toEqual([]);
  });

  test('streamMarginCallUpdates() / streamTrades() / streamUserUpdates() / streamSymbolUpdates() invoke matching methods', async () => {
    const c = new MT4V2SignalRClient({
      baseUrl: 'http://localhost:5002',
      tradePlatform: '11111111-2222-3333-4444-555555555555',
      token: 'eyJ.fake.token',
    });
    await c.start();
    c.streamMarginCallUpdates()[Symbol.asyncIterator]().next();
    c.streamTrades()[Symbol.asyncIterator]().next();
    c.streamUserUpdates()[Symbol.asyncIterator]().next();
    c.streamSymbolUpdates()[Symbol.asyncIterator]().next();
    const methods = lastConnection!.streams.map(x => x.method);
    expect(methods).toContain('StreamMarginCallUpdates');
    expect(methods).toContain('StreamTrades');
    expect(methods).toContain('StreamUserUpdates');
    expect(methods).toContain('StreamSymbolUpdates');
  });

  test('async iterator completes when server stream completes', async () => {
    const c = new MT4V2SignalRClient({
      baseUrl: 'http://localhost:5002',
      tradePlatform: '11111111-2222-3333-4444-555555555555',
      token: 'eyJ.fake.token',
    });
    await c.start();

    const collected: number[] = [];
    const iterPromise = (async () => {
      for await (const t of c.streamTicks() as AsyncIterable<{ bid: number }>) {
        collected.push(t.bid);
      }
    })();

    // Wait one tick for subscription
    await Promise.resolve();
    const s = lastConnection!.streams.find(x => x.method === 'StreamTicks')!.stream;
    s.emit({ symbol: 'EURUSD', bid: 1.1, ask: 1.2, lastTime: null });
    s.emit({ symbol: 'EURUSD', bid: 1.15, ask: 1.25, lastTime: null });
    s.complete();
    await iterPromise;

    expect(collected).toEqual([1.1, 1.15]);
  });

  test('breaking out of for-await disposes the underlying server stream', async () => {
    const c = new MT4V2SignalRClient({
      baseUrl: 'http://localhost:5002',
      tradePlatform: '11111111-2222-3333-4444-555555555555',
      token: 'eyJ.fake.token',
    });
    await c.start();

    const ticks = c.streamTicks() as AsyncIterable<{ bid: number }>;
    const collected: number[] = [];
    let captured: FakeStreamResult<unknown> | undefined;
    const iterPromise = (async () => {
      for await (const t of ticks) {
        collected.push(t.bid);
        captured = lastConnection!.streams.find(x => x.method === 'StreamTicks')!.stream;
        break;
      }
    })();
    await Promise.resolve();
    const s = lastConnection!.streams.find(x => x.method === 'StreamTicks')!.stream;
    s.emit({ bid: 1.1 });
    await iterPromise;

    expect(collected).toEqual([1.1]);
    expect(captured?.disposed).toBe(true);
  });
});

// * --- Callbacks -------------------------------------------------------------

describe('MT4V2SignalRClient — callbacks', () => {
  test('subscribeToTicks() invokes server method', async () => {
    const c = new MT4V2SignalRClient({
      baseUrl: 'http://localhost:5002',
      tradePlatform: '11111111-2222-3333-4444-555555555555',
      token: 'eyJ.fake.token',
    });
    await c.start();
    await c.subscribeToTicks('EURUSD');
    expect(lastConnection?.invokes).toEqual([{ method: 'SubscribeToTicks', args: ['EURUSD'] }]);
  });

  test('unsubscribeFromTicks() invokes server method', async () => {
    const c = new MT4V2SignalRClient({
      baseUrl: 'http://localhost:5002',
      tradePlatform: '11111111-2222-3333-4444-555555555555',
      token: 'eyJ.fake.token',
    });
    await c.start();
    await c.unsubscribeFromTicks('EURUSD');
    expect(lastConnection?.invokes).toEqual([{ method: 'UnsubscribeFromTicks', args: ['EURUSD'] }]);
  });

  test('onTick() registers a server -> client callback', async () => {
    const c = new MT4V2SignalRClient({
      baseUrl: 'http://localhost:5002',
      tradePlatform: '11111111-2222-3333-4444-555555555555',
      token: 'eyJ.fake.token',
    });
    await c.start();
    const received: Array<{ bid: number }> = [];
    c.onTick((p: { bid: number }) => { received.push(p); });
    expect(typeof lastConnection?.handlers['OnTick']).toBe('function');
    lastConnection!.handlers['OnTick']!({ bid: 1.1 });
    expect(received).toEqual([{ bid: 1.1 }]);
  });

  test('getConnection() throws before start()', () => {
    const c = new MT4V2SignalRClient({
      baseUrl: 'http://localhost:5002',
      tradePlatform: '11111111-2222-3333-4444-555555555555',
      token: 'eyJ.fake.token',
    });
    expect(() => c.getConnection()).toThrow(MT4V2SignalRError);
  });
});

// * --- stop() ----------------------------------------------------------------

describe('MT4V2SignalRClient — stop()', () => {
  test('stop() closes the connection', async () => {
    const c = new MT4V2SignalRClient({
      baseUrl: 'http://localhost:5002',
      tradePlatform: '11111111-2222-3333-4444-555555555555',
      token: 'eyJ.fake.token',
    });
    await c.start();
    await c.stop();
    expect(lastConnection?.stopCalls).toBe(1);
  });

  test('stop() before start() is a no-op', async () => {
    const c = new MT4V2SignalRClient({
      baseUrl: 'http://localhost:5002',
      tradePlatform: '11111111-2222-3333-4444-555555555555',
      token: 'eyJ.fake.token',
    });
    await c.stop();
    // No connection was created; nothing to assert beyond "did not throw"
    expect(lastConnection).toBeNull();
  });
});

// * --- Pre-start callback registration (race-free) ---------------------------
//
// * The server pushes OnConnectionStatus immediately after the WebSocket
// *   handshake completes. If the callback is registered AFTER conn.start()
// *   resolves, there is a window where the push arrives before the handler
// *   is wired. The fix: queue handlers in pendingHandlers and drain them
// *   onto the HubConnection BEFORE conn.start() is called.
//
// * These tests verify the ordering guarantee: .on() must be called on the
// *   FakeHubConnection before .start() is called on it.

describe('MT4V2SignalRClient — pre-start callback registration', () => {
  test('onConnectionStatus() registered before start() does NOT throw', () => {
    const c = new MT4V2SignalRClient({
      baseUrl: 'http://localhost:5002',
      tradePlatform: '11111111-2222-3333-4444-555555555555',
      token: 'eyJ.fake.token',
    });
    // Must not throw — the handler is queued, not applied yet.
    expect(() => c.onConnectionStatus((_p) => {})).not.toThrow();
    // Connection has NOT been built yet at this point.
    expect(lastConnection).toBeNull();
  });

  test('onTick() registered before start() does NOT throw', () => {
    const c = new MT4V2SignalRClient({
      baseUrl: 'http://localhost:5002',
      tradePlatform: '11111111-2222-3333-4444-555555555555',
      token: 'eyJ.fake.token',
    });
    expect(() => c.onTick((_p) => {})).not.toThrow();
    expect(lastConnection).toBeNull();
  });

  test('onConnectionStatus() registered before start() is wired BEFORE conn.start()', async () => {
    // * Track the order in which .on() and .start() are called on the
    // *   FakeHubConnection. The handler must be attached before the
    // *   connection is opened, so .on() must appear before .start() in the log.
    const callOrder: string[] = [];

    // * Patch the FakeHubConnectionBuilder so we can intercept .on() and
    // *   .start() calls on the connection it produces without touching the
    // *   module-level FakeHubConnection class.
    const originalBuild = FakeHubConnectionBuilder.prototype.build;
    FakeHubConnectionBuilder.prototype.build = function () {
      const conn = originalBuild.call(this);
      const origOn    = conn.on.bind(conn);
      const origStart = conn.start.bind(conn);
      conn.on    = (event: string, handler: (...args: unknown[]) => void) => {
        callOrder.push(`on:${event}`);
        origOn(event, handler);
      };
      conn.start = async () => {
        callOrder.push('start');
        return origStart();
      };
      return conn;
    };

    try {
      const c = new MT4V2SignalRClient({
        baseUrl: 'http://localhost:5002',
        tradePlatform: '11111111-2222-3333-4444-555555555555',
        token: 'eyJ.fake.token',
      });

      // * Register BEFORE start().
      c.onConnectionStatus((_p) => {});
      await c.start();

      // * The handler must have been attached before the socket opened.
      const onIdx    = callOrder.indexOf('on:OnConnectionStatus');
      const startIdx = callOrder.indexOf('start');
      expect(onIdx).toBeGreaterThanOrEqual(0);
      expect(startIdx).toBeGreaterThanOrEqual(0);
      expect(onIdx).toBeLessThan(startIdx);
    } finally {
      // Restore original build method.
      FakeHubConnectionBuilder.prototype.build = originalBuild;
    }
  });

  test('onTick() registered before start() is wired BEFORE conn.start()', async () => {
    const callOrder: string[] = [];

    const originalBuild = FakeHubConnectionBuilder.prototype.build;
    FakeHubConnectionBuilder.prototype.build = function () {
      const conn = originalBuild.call(this);
      const origOn    = conn.on.bind(conn);
      const origStart = conn.start.bind(conn);
      conn.on    = (event: string, handler: (...args: unknown[]) => void) => {
        callOrder.push(`on:${event}`);
        origOn(event, handler);
      };
      conn.start = async () => {
        callOrder.push('start');
        return origStart();
      };
      return conn;
    };

    try {
      const c = new MT4V2SignalRClient({
        baseUrl: 'http://localhost:5002',
        tradePlatform: '11111111-2222-3333-4444-555555555555',
        token: 'eyJ.fake.token',
      });

      c.onTick((_p) => {});
      await c.start();

      const onIdx    = callOrder.indexOf('on:OnTick');
      const startIdx = callOrder.indexOf('start');
      expect(onIdx).toBeGreaterThanOrEqual(0);
      expect(startIdx).toBeGreaterThanOrEqual(0);
      expect(onIdx).toBeLessThan(startIdx);
    } finally {
      FakeHubConnectionBuilder.prototype.build = originalBuild;
    }
  });

  test('onConnectionStatus() registered AFTER start() is wired immediately', async () => {
    const c = new MT4V2SignalRClient({
      baseUrl: 'http://localhost:5002',
      tradePlatform: '11111111-2222-3333-4444-555555555555',
      token: 'eyJ.fake.token',
    });
    await c.start();
    // Registering after start() must still work — handler applied immediately.
    const received: unknown[] = [];
    c.onConnectionStatus((p) => { received.push(p); });
    expect(typeof lastConnection?.handlers['OnConnectionStatus']).toBe('function');
    lastConnection!.handlers['OnConnectionStatus']!({ connected: true });
    expect(received).toEqual([{ connected: true }]);
  });
});

// * --- MT4V2SignalRClient — default OnConnectionStatus sink ------------------
//
// * Stream-only consumers never call onConnectionStatus(). Without a default
//   sink, @microsoft/signalr would log:
//   "Warning: No client method with the name 'onconnectionstatus' found."
//   on every connection. The fix registers a no-op handler in start() so
//   the server's guaranteed post-handshake push is always silently consumed.

describe('MT4V2SignalRClient — default OnConnectionStatus sink', () => {
  test('start() registers OnConnectionStatus even when consumer never calls onConnectionStatus()', async () => {
    // * Stream-only consumer — no onConnectionStatus() call.
    const c = new MT4V2SignalRClient({
      baseUrl:       'http://localhost:5002',
      tradePlatform: '11111111-2222-3333-4444-555555555555',
      token:         'eyJ.fake.token',
    });
    await c.start();
    // * Default sink must be registered so the server push is consumed silently.
    expect(typeof lastConnection?.handlers['OnConnectionStatus']).toBe('function');
  });

  test('default OnConnectionStatus sink is registered BEFORE conn.start()', async () => {
    const callOrder: string[] = [];

    const originalBuild = FakeHubConnectionBuilder.prototype.build;
    FakeHubConnectionBuilder.prototype.build = function () {
      const conn      = originalBuild.call(this);
      const origOn    = conn.on.bind(conn);
      const origStart = conn.start.bind(conn);
      conn.on    = (event: string, handler: (...args: unknown[]) => void) => {
        callOrder.push(`on:${event}`);
        origOn(event, handler);
      };
      conn.start = async () => {
        callOrder.push('start');
        return origStart();
      };
      return conn;
    };

    try {
      // * Stream-only consumer — no onConnectionStatus() call.
      const c = new MT4V2SignalRClient({
        baseUrl:       'http://localhost:5002',
        tradePlatform: '11111111-2222-3333-4444-555555555555',
        token:         'eyJ.fake.token',
      });
      await c.start();

      // * The default sink must appear in the log before 'start'.
      const onIdx    = callOrder.indexOf('on:OnConnectionStatus');
      const startIdx = callOrder.indexOf('start');
      expect(onIdx).toBeGreaterThanOrEqual(0);
      expect(startIdx).toBeGreaterThanOrEqual(0);
      expect(onIdx).toBeLessThan(startIdx);
    } finally {
      FakeHubConnectionBuilder.prototype.build = originalBuild;
    }
  });
});

// * --- MT5V2SignalRClient — pre-start callback registration ------------------

describe('MT5V2SignalRClient — pre-start callback registration', () => {
  test('onConnectionStatus() registered before start() does NOT throw', () => {
    const c = new MT5V2SignalRClient({
      baseUrl: 'http://localhost:5002',
      tradePlatform: '11111111-2222-3333-4444-555555555555',
      token: 'eyJ.fake.token',
    });
    expect(() => c.onConnectionStatus((_p) => {})).not.toThrow();
    expect(lastConnection).toBeNull();
  });

  test('onConnectionStatus() registered before start() is wired BEFORE conn.start()', async () => {
    const callOrder: string[] = [];

    const originalBuild = FakeHubConnectionBuilder.prototype.build;
    FakeHubConnectionBuilder.prototype.build = function () {
      const conn = originalBuild.call(this);
      const origOn    = conn.on.bind(conn);
      const origStart = conn.start.bind(conn);
      conn.on    = (event: string, handler: (...args: unknown[]) => void) => {
        callOrder.push(`on:${event}`);
        origOn(event, handler);
      };
      conn.start = async () => {
        callOrder.push('start');
        return origStart();
      };
      return conn;
    };

    try {
      const c = new MT5V2SignalRClient({
        baseUrl: 'http://localhost:5002',
        tradePlatform: '11111111-2222-3333-4444-555555555555',
        token: 'eyJ.fake.token',
      });

      // * Register BEFORE start().
      c.onConnectionStatus((_p) => {});
      await c.start();

      const onIdx    = callOrder.indexOf('on:OnConnectionStatus');
      const startIdx = callOrder.indexOf('start');
      expect(onIdx).toBeGreaterThanOrEqual(0);
      expect(startIdx).toBeGreaterThanOrEqual(0);
      expect(onIdx).toBeLessThan(startIdx);
    } finally {
      FakeHubConnectionBuilder.prototype.build = originalBuild;
    }
  });

  test('onConnectionStatus() registered AFTER start() is wired immediately', async () => {
    const c = new MT5V2SignalRClient({
      baseUrl: 'http://localhost:5002',
      tradePlatform: '11111111-2222-3333-4444-555555555555',
      token: 'eyJ.fake.token',
    });
    await c.start();
    const received: unknown[] = [];
    c.onConnectionStatus((p) => { received.push(p); });
    expect(typeof lastConnection?.handlers['OnConnectionStatus']).toBe('function');
    lastConnection!.handlers['OnConnectionStatus']!({ connected: true });
    expect(received).toEqual([{ connected: true }]);
  });
});

// * --- MT5V2SignalRClient — default OnConnectionStatus sink ------------------
//
// * Mirror of the MT4 default-sink tests for the MT5 client. Same guarantee:
//   a stream-only consumer must not trigger the "no client method" warning.

describe('MT5V2SignalRClient — default OnConnectionStatus sink', () => {
  test('start() registers OnConnectionStatus even when consumer never calls onConnectionStatus()', async () => {
    // * Stream-only consumer — no onConnectionStatus() call.
    const c = new MT5V2SignalRClient({
      baseUrl:       'http://localhost:5002',
      tradePlatform: '11111111-2222-3333-4444-555555555555',
      token:         'eyJ.fake.token',
    });
    await c.start();
    // * Default sink must be registered so the server push is consumed silently.
    expect(typeof lastConnection?.handlers['OnConnectionStatus']).toBe('function');
  });

  test('default OnConnectionStatus sink is registered BEFORE conn.start()', async () => {
    const callOrder: string[] = [];

    const originalBuild = FakeHubConnectionBuilder.prototype.build;
    FakeHubConnectionBuilder.prototype.build = function () {
      const conn      = originalBuild.call(this);
      const origOn    = conn.on.bind(conn);
      const origStart = conn.start.bind(conn);
      conn.on    = (event: string, handler: (...args: unknown[]) => void) => {
        callOrder.push(`on:${event}`);
        origOn(event, handler);
      };
      conn.start = async () => {
        callOrder.push('start');
        return origStart();
      };
      return conn;
    };

    try {
      // * Stream-only consumer — no onConnectionStatus() call.
      const c = new MT5V2SignalRClient({
        baseUrl:       'http://localhost:5002',
        tradePlatform: '11111111-2222-3333-4444-555555555555',
        token:         'eyJ.fake.token',
      });
      await c.start();

      // * The default sink must appear in the log before 'start'.
      const onIdx    = callOrder.indexOf('on:OnConnectionStatus');
      const startIdx = callOrder.indexOf('start');
      expect(onIdx).toBeGreaterThanOrEqual(0);
      expect(startIdx).toBeGreaterThanOrEqual(0);
      expect(onIdx).toBeLessThan(startIdx);
    } finally {
      FakeHubConnectionBuilder.prototype.build = originalBuild;
    }
  });
});
