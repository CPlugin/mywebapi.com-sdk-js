// CPluginWebApiClient — unified entry point for the v2 MT4/MT5 SDK.
//
// Usage:
//   const client = new CPluginWebApiClient({ env: 'staging', clientId, clientSecret });
//   const time = await client.mt4.getServerTime('my-tp');
//   const page = await client.paged(() =>
//     client.mt4.getUserRecordsRequest('my-tp'),
//   );

import {
  ClientCredentialsTokenProvider,
  type TokenProvider,
} from './auth';
import { MT4V2SignalRClient, type SignalRClientExtras } from './signalr';
import { MT5V2SignalRClient } from './signalr.mt5';
import type { RetryPolicy } from './retry';
import { defaultPolicy } from './retry';
import { resolveEnvironment, type EnvironmentSelector } from './environments';
import { withContext, currentContextOrNull, type RequestContext } from './mutator.context';
import { type UnwrapEnvelope } from './mutator';
import type { PagedResult } from './pagination';
import { ApiError, type ApiErrorBody } from './errors';

// ---------------------------------------------------------------------------
// TradePlatform — discovery type for GET /api/TradePlatforms
// ---------------------------------------------------------------------------

/** A trade platform the authenticated principal can access.
 *
 *  Shape mirrors the server `TradePlatform` entity (serialized camelCase by STJ).
 *  Known fields confirmed against a live server response (2026-06-26).
 *  The index signature absorbs extra fields so client code does not break
 *  if the server adds properties in future versions. */
export interface TradePlatform {
  /** Platform GUID — pass as `tradePlatform` to every MT4/MT5 endpoint. */
  id: string;
  /** Human-readable display name (e.g. "Demo MT4 London"). */
  name?: string | null;
  // * "MT4" or "MT5" (string enum on the server, serialized to string by STJ).
  //   Typed as union to survive undocumented enum additions gracefully.
  type?: string | number | null;
  /** Manager login used for this platform connection. */
  login?: number | null;
  /** Organization (tenant) GUID this platform belongs to. */
  organizationId?: string | null;
  /** Nested organization object — id + name + created timestamp. */
  organization?: { id: string; name: string; created: string } | null;
  /** ISO 8601 creation timestamp of this platform record. */
  created?: string | null;
  [key: string]: unknown;
}
// ---------------------------------------------------------------------------
// Generated per-tag endpoint modules — MT4
// ---------------------------------------------------------------------------
import * as mt4Authentication from './generated/mt4-v2-authentication';
import * as mt4BackupDestructive from './generated/mt4-v2-backup-destructive';
import * as mt4Backup from './generated/mt4-v2-backup';
import * as mt4Common from './generated/mt4-v2-common';
import * as mt4Config from './generated/mt4-v2-config';
import * as mt4Groups from './generated/mt4-v2-groups';
import * as mt4History from './generated/mt4-v2-history';
import * as mt4Mail from './generated/mt4-v2-mail';
import * as mt4Margins from './generated/mt4-v2-margins';
import * as mt4News from './generated/mt4-v2-news';
import * as mt4Online from './generated/mt4-v2-online';
import * as mt4Plugins from './generated/mt4-v2-plugins';
import * as mt4Prices from './generated/mt4-v2-prices';
import * as mt4Reports from './generated/mt4-v2-reports';
import * as mt4ServerAdminDestructive from './generated/mt4-v2-server-admin-destructive';
import * as mt4ServerAdmin from './generated/mt4-v2-server-admin';
import * as mt4Symbols from './generated/mt4-v2-symbols';
import * as mt4Trades from './generated/mt4-v2-trades';
import * as mt4Users from './generated/mt4-v2-users';

// ---------------------------------------------------------------------------
// Generated per-tag endpoint modules — MT5
// ---------------------------------------------------------------------------
import * as mt5Common from './generated/mt5-v2-common';
import * as mt5Groups from './generated/mt5-v2-groups';
import * as mt5Managers from './generated/mt5-v2-managers';
import * as mt5Symbols from './generated/mt5-v2-symbols';
import * as mt5Trades from './generated/mt5-v2-trades';
import * as mt5Users from './generated/mt5-v2-users';

// ---------------------------------------------------------------------------
// Legacy type — kept for MT4V2SignalRClient backwards compatibility.
// MT4V2SignalRClient in signalr.ts uses this discriminated union as its base
// options type. It is NOT exported from index.ts (new code uses CPluginWebApiClientInit).
// ---------------------------------------------------------------------------

export type MT4V2ClientOptions =
  | {
      baseUrl: string;
      tradePlatform: string;
      token: string;
      fetch?: typeof fetch;
      retry?: Partial<RetryPolicy>;
    }
  | {
      baseUrl: string;
      tradePlatform: string;
      clientId: string;
      clientSecret: string;
      identityUrl: string;
      scopes?: readonly string[];
      fetch?: typeof fetch;
      retry?: Partial<RetryPolicy>;
    };

// ---------------------------------------------------------------------------
// Public option types
// ---------------------------------------------------------------------------

export interface CPluginWebApiClientOptions {
  clientId: string;
  clientSecret: string;
  scopes?: readonly string[];
  /** Inject a custom fetch implementation (testing / Bun / Node polyfill). */
  fetch?: typeof fetch;
  /** Override individual retry-policy fields. */
  retry?: Partial<RetryPolicy>;
}

/** Combine environment selector with client credentials. */
export type CPluginWebApiClientInit = EnvironmentSelector & CPluginWebApiClientOptions;

// ---------------------------------------------------------------------------
// Namespace type utilities — strip redundant platform token from method names.
// ---------------------------------------------------------------------------

// * Strips a trailing platform token (e.g. 'MT4' / 'MT5') from a key string.
//   Used so that client.mt4.getServerTimeMT4 is exposed as client.mt4.getServerTime —
//   the platform is already implied by which namespace the caller is in.
type StripPlatform<K, P extends string> = K extends `${infer Base}${P}` ? Base : K;

// * Re-maps all keys of M, stripping the trailing platform token P from any that carry it.
//   Non-suffixed keys pass through unchanged.
type CleanNamespace<M, P extends string> = {
  [K in keyof M as StripPlatform<K & string, P>]: M[K];
};

// ---------------------------------------------------------------------------
// Namespace type unions — every MT4 / MT5 tag module spread together.
// BoundModule<M> is used so every endpoint function resolves to the unwrapped
// data type (via UnwrapEnvelope) rather than the raw ResponseSuccess envelope.
// CleanNamespace strips the trailing platform suffix from the 3 cross-platform
// methods (getServerTime, patchGroupRecordGroup, patchUserRecordLogin) so the
// caller sees clean names without the redundant MT4/MT5 token.
// ---------------------------------------------------------------------------

type MT4Namespace = CleanNamespace<
  BoundModule<typeof mt4Authentication> &
  BoundModule<typeof mt4BackupDestructive> &
  BoundModule<typeof mt4Backup> &
  BoundModule<typeof mt4Common> &
  BoundModule<typeof mt4Config> &
  BoundModule<typeof mt4Groups> &
  BoundModule<typeof mt4History> &
  BoundModule<typeof mt4Mail> &
  BoundModule<typeof mt4Margins> &
  BoundModule<typeof mt4News> &
  BoundModule<typeof mt4Online> &
  BoundModule<typeof mt4Plugins> &
  BoundModule<typeof mt4Prices> &
  BoundModule<typeof mt4Reports> &
  BoundModule<typeof mt4ServerAdminDestructive> &
  BoundModule<typeof mt4ServerAdmin> &
  BoundModule<typeof mt4Symbols> &
  BoundModule<typeof mt4Trades> &
  BoundModule<typeof mt4Users>,
  'MT4'
>;

type MT5Namespace = CleanNamespace<
  BoundModule<typeof mt5Common> &
  BoundModule<typeof mt5Groups> &
  BoundModule<typeof mt5Managers> &
  BoundModule<typeof mt5Symbols> &
  BoundModule<typeof mt5Trades> &
  BoundModule<typeof mt5Users>,
  'MT5'
>;

// ---------------------------------------------------------------------------
// bind() helper — wraps every exported function so it runs inside a context
// and exposes the unwrapped data type as the return type.
//
// The generated functions return Promise<ResponseSuccess> at the type level
// but customFetch returns the unwrapped envelope.data at runtime. bind() bridges
// the gap: BoundModule<M> maps every async function in M so its return type
// resolves through UnwrapEnvelope twice (orval outer + v2 inner) — matching
// what callers actually receive.
//
// * Per-call isolation: each top-level call gets a fresh RequestContext so that
//   concurrent calls (e.g. two paged() at once) never share a mutable lastMeta
//   slot. Nested calls that already run inside a withContext scope (e.g. the
//   generated call inside paged()) reuse the outer context so that customFetch
//   writes lastMeta into the scope that paged() will read.
// ---------------------------------------------------------------------------

// * Maps a generated module type: every async function has its resolved return
//   type unwrapped through UnwrapEnvelope TWICE — once for the orval outer
//   envelope ({ data: XxxApiResponse; status; headers }) and once for our v2
//   inner envelope (XxxApiResponse = { data?: <payload>; error?; meta? }).
//   For void/primitive results the second application is a no-op because a
//   primitive does not extend { data? }, so UnwrapEnvelope returns it as-is.
type BoundModule<M> = {
  [K in keyof M]: M[K] extends (...args: infer A) => Promise<infer R>
    ? (...args: A) => Promise<UnwrapEnvelope<UnwrapEnvelope<R>>>
    : M[K];
};

type AnyFn = (...args: never[]) => Promise<unknown>;

// * base holds the immutable connection config shared by all calls from this
//   client instance. lastMeta is intentionally ABSENT — it lives only on the
//   per-call context created inside bind() and paged(), so concurrent calls
//   can never overwrite each other's cursor.
type BaseContext = Omit<RequestContext, 'lastMeta'>;

// * Bind a generated module to a base context, optionally stripping a trailing
//   platform suffix (e.g. 'MT4') from exported function names. This keeps the
//   generated code untouched while exposing clean names at the namespace layer:
//     getServerTimeMT4 → getServerTime  (inside client.mt4)
//     getServerTimeMT5 → getServerTime  (inside client.mt5)
//   Only an exact trailing match is stripped; all other names pass through as-is.
//
//   The return type is CleanNamespace<BoundModule<M>, P> when a suffix is given,
//   so the TypeScript-visible keys already carry the stripped names and the
//   caller's `as MT4Namespace` cast succeeds without widening through `unknown`.
function bind<M extends Record<string, unknown>>(
  mod: M,
  base: BaseContext,
): BoundModule<M>;
function bind<M extends Record<string, unknown>, P extends string>(
  mod: M,
  base: BaseContext,
  platformSuffix: P,
): CleanNamespace<BoundModule<M>, P>;
function bind<M extends Record<string, unknown>>(
  mod: M,
  base: BaseContext,
  platformSuffix?: string,
): BoundModule<M> {
  const out: Record<string, unknown> = {};
  for (const [name, value] of Object.entries(mod)) {
    // * Compute the exposed key: strip the trailing platform token if present.
    const key =
      platformSuffix && name.endsWith(platformSuffix)
        ? name.slice(0, -platformSuffix.length)
        : name;

    if (typeof value !== 'function') {
      out[key] = value;
      continue;
    }
    out[key] = (...args: never[]) => {
      // * If already inside a withContext scope (nested call, e.g. inside
      //   paged()), reuse it so customFetch writes into the same lastMeta slot
      //   that the outer paged() scope will read.
      const active = currentContextOrNull();
      if (active) return (value as AnyFn)(...args);
      // * Top-level call: allocate a fresh per-call context with its own
      //   lastMeta slot to prevent concurrent calls from crossing.
      const perCall: RequestContext = { ...base, lastMeta: null };
      return withContext(perCall, () => (value as AnyFn)(...args));
    };
  }
  return out as BoundModule<M>;
}

// ---------------------------------------------------------------------------
// CPluginWebApiClient
// ---------------------------------------------------------------------------

/**
 * Unified entry point for the CPlugin SaaS WebAPI v2 — MT4 and MT5 trading platform management.
 *
 * Client credentials (ID and secret) and trade platform configuration are managed in the CPlugin Toolbox
 * (staging: https://pre.toolbox.cplugin.com, production: https://toolbox.cplugin.com).
 * Once configured, access all MT4 and MT5 endpoints via the `mt4` and `mt5` namespaces and discover
 * available platforms via `listTradePlatforms()`. Token management (OAuth2 client credentials flow) is
 * handled automatically.
 */
export class CPluginWebApiClient {
  /** All MT4 v2 endpoint functions, pre-wired to this client's context. */
  readonly mt4: MT4Namespace;
  /** All MT5 v2 endpoint functions, pre-wired to this client's context. */
  readonly mt5: MT5Namespace;

  // * Real-time SignalR accessor — shares the OAuth token provider so REST and
  // *   SignalR clients use the same cached bearer token with no second OAuth round-trip.
  readonly realtime: {
    /** Create an `MT4V2SignalRClient` for the given trade platform, wired to this
     *  client's shared token provider and base URL. Call `start()` on the result
     *  to open the WebSocket connection. */
    mt4(tradePlatform: string, extras?: SignalRClientExtras): MT4V2SignalRClient;
    /** Create an `MT5V2SignalRClient` for the given trade platform, wired to this
     *  client's shared token provider and base URL. Call `start()` on the result
     *  to open the WebSocket connection. */
    mt5(tradePlatform: string, extras?: SignalRClientExtras): MT5V2SignalRClient;
  };

  // * Immutable connection config — no mutable lastMeta here. Each call
  //   (via bind or paged) creates its own fresh per-call context.
  private readonly base: BaseContext;

  constructor(init: CPluginWebApiClientInit) {
    const env = resolveEnvironment(init);

    const tokenProvider: TokenProvider = new ClientCredentialsTokenProvider({
      clientId: init.clientId,
      clientSecret: init.clientSecret,
      // * ClientCredentialsOptions uses `identityUrl`; the environment preset
      //   exposes it as `authority`. Map explicitly.
      identityUrl: env.authority,
      ...(init.scopes ? { scopes: init.scopes } : {}),
      ...(init.fetch ? { fetch: init.fetch } : {}),
    });

    this.base = {
      apiBaseUrl: env.apiBaseUrl,
      tokenProvider,
      fetchImpl: init.fetch ?? globalThis.fetch.bind(globalThis),
      retryPolicy: { ...defaultPolicy, ...(init.retry ?? {}) },
    };

    // * Build each namespace by spreading all bound tag modules together.
    //   Pass the platform suffix so bind() strips it from the 3 cross-platform
    //   method names that orval suffixed for global uniqueness.
    this.mt4 = {
      ...bind(mt4Authentication, this.base, 'MT4'),
      ...bind(mt4BackupDestructive, this.base, 'MT4'),
      ...bind(mt4Backup, this.base, 'MT4'),
      ...bind(mt4Common, this.base, 'MT4'),
      ...bind(mt4Config, this.base, 'MT4'),
      ...bind(mt4Groups, this.base, 'MT4'),
      ...bind(mt4History, this.base, 'MT4'),
      ...bind(mt4Mail, this.base, 'MT4'),
      ...bind(mt4Margins, this.base, 'MT4'),
      ...bind(mt4News, this.base, 'MT4'),
      ...bind(mt4Online, this.base, 'MT4'),
      ...bind(mt4Plugins, this.base, 'MT4'),
      ...bind(mt4Prices, this.base, 'MT4'),
      ...bind(mt4Reports, this.base, 'MT4'),
      ...bind(mt4ServerAdminDestructive, this.base, 'MT4'),
      ...bind(mt4ServerAdmin, this.base, 'MT4'),
      ...bind(mt4Symbols, this.base, 'MT4'),
      ...bind(mt4Trades, this.base, 'MT4'),
      ...bind(mt4Users, this.base, 'MT4'),
    } as MT4Namespace;

    this.mt5 = {
      ...bind(mt5Common, this.base, 'MT5'),
      ...bind(mt5Groups, this.base, 'MT5'),
      ...bind(mt5Managers, this.base, 'MT5'),
      ...bind(mt5Symbols, this.base, 'MT5'),
      ...bind(mt5Trades, this.base, 'MT5'),
      ...bind(mt5Users, this.base, 'MT5'),
    } as MT5Namespace;

    // * Wire realtime accessor — captures base so the SignalR client shares
    // *   the same tokenProvider and apiBaseUrl as the REST namespaces above.
    const base = this.base;
    this.realtime = {
      mt4: (tradePlatform, extras) =>
        new MT4V2SignalRClient({
          tokenProvider: base.tokenProvider,
          baseUrl: base.apiBaseUrl,
          tradePlatform,
          ...(extras ?? {}),
        }),
      mt5: (tradePlatform, extras) =>
        new MT5V2SignalRClient({
          tokenProvider: base.tokenProvider,
          baseUrl: base.apiBaseUrl,
          tradePlatform,
          ...(extras ?? {}),
        }),
    };
  }

  // * Run a generated paged endpoint and surface { items, paging } by reading
  //   lastMeta written by customFetch into the per-call context scope.
  //   Each paged() invocation creates its own fresh context so that concurrent
  //   paged() calls never share a lastMeta slot.
  //   BoundModule wraps every generated function via UnwrapEnvelope so the
  //   parameter type is Promise<T[]> — no caller cast needed for MT4/MT5 methods
  //   that return list types; mock-only tests still cast when the mock fixture
  //   type does not match the resolved generated type.
  async paged<T>(call: () => Promise<T[]>): Promise<PagedResult<T>> {
    // * Allocate a fresh per-call context; bind() detects the active scope via
    //   currentContextOrNull() and reuses this same context for the inner
    //   generated call, so customFetch writes lastMeta here.
    const perCall: RequestContext = { ...this.base, lastMeta: null };
    return withContext(perCall, async () => {
      const items = await call();
      return {
        items: Array.isArray(items) ? (items as T[]) : [],
        paging: perCall.lastMeta?.paging ?? null,
      };
    });
  }

  // ---------------------------------------------------------------------------
  // * Trade platform discovery — GET /api/TradePlatforms
  // ---------------------------------------------------------------------------
  //
  // Returns the list of trade platforms the authenticated principal has access to.
  // This endpoint lives OUTSIDE the v2 envelope surface (no {data,error,meta} wrapper)
  // at the unversioned path /api/TradePlatforms — it is handled here as a hand-written
  // helper rather than a generated endpoint.
  //
  // Use the returned `id` values as the `tradePlatform` argument for all MT4/MT5 calls.
  //
  // ! On HTTP 401 the method force-refreshes the token once and retries.
  //   Any non-2xx response after that throws ApiError.
  /**
   * Discover trade platforms available to the authenticated principal.
   *
   * Trade platforms are managed in the CPlugin Toolbox (staging: https://pre.toolbox.cplugin.com,
   * production: https://toolbox.cplugin.com). Use the returned platform `id` values as the
   * `tradePlatform` parameter for all MT4 and MT5 endpoint calls.
   *
   * @returns Array of trade platforms the authenticated user can access.
   * @throws ApiError if authentication fails or the API request returns an error.
   */
  async listTradePlatforms(): Promise<TradePlatform[]> {
    const url = `${this.base.apiBaseUrl}/api/TradePlatforms`;

    const doFetch = async (forceRefresh: boolean): Promise<Response> => {
      const token = await this.base.tokenProvider.getToken({ forceRefresh });
      return this.base.fetchImpl(url, {
        method: 'GET',
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: 'application/json',
        },
      });
    };

    let res = await doFetch(false);

    // * Single retry after a 401 — token may have expired mid-flight.
    if (res.status === 401) {
      res = await doFetch(true);
    }

    if (!res.ok) {
      // * Map well-known status codes to typed WebApiErrorCode values.
      const code: ApiErrorBody['code'] =
        res.status === 401 || res.status === 403
          ? 'Forbidden'
          : res.status === 404
            ? 'NotFound'
            : 'Internal';
      throw new ApiError(
        { code, message: `GET /api/TradePlatforms failed: HTTP ${res.status}` },
        null,
        res.status,
      );
    }

    return res.json() as Promise<TradePlatform[]>;
  }
}
