// Public surface of the @cplugin/webapi-client SDK.
//
// Primary entry point: construct a CPluginWebApiClient and access MT4/MT5 endpoints
// via the mt4 / mt5 namespaces. Use paged() to surface cursor pagination.

// ---------------------------------------------------------------------------
// Client
// ---------------------------------------------------------------------------
export { CPluginWebApiClient } from './client';
export type { CPluginWebApiClientOptions, CPluginWebApiClientInit, TradePlatform } from './client';

// ---------------------------------------------------------------------------
// Environments
// ---------------------------------------------------------------------------
export { resolveEnvironment } from './environments';
export type { EnvironmentName, ResolvedEnvironment, EnvironmentSelector } from './environments';

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------
export { ApiError } from './errors';
export type {
  WebApiErrorCode,
  PagingMeta,
  ApiMeta,
  ApiErrorBody,
  ApiEnvelope,
} from './errors';

// ---------------------------------------------------------------------------
// Pagination helpers
// ---------------------------------------------------------------------------
export { paginate, collectAll } from './pagination';
export type { PagedResult } from './pagination';

// ---------------------------------------------------------------------------
// Auth primitives (advanced use — most callers should use CPluginWebApiClient)
// ---------------------------------------------------------------------------
export {
  StaticTokenProvider,
  ClientCredentialsTokenProvider,
  OAuth2TokenError,
  type TokenProvider,
  type ClientCredentialsOptions,
} from './auth';

// ---------------------------------------------------------------------------
// Retry
// ---------------------------------------------------------------------------
export { defaultPolicy, type RetryPolicy } from './retry';

// ---------------------------------------------------------------------------
// SignalR — real-time streaming (MT4 v2 hub)
// ---------------------------------------------------------------------------
export {
  MT4V2SignalRClient,
  MT4V2SignalRError,
  type MT4V2SignalRClientOptions,
  type SignalRClientExtras,
  type ConnectionStatusPayload,
  type TickPayload,
  type MarginCallPayload,
  type TradeUpdatePayload,
  type UserUpdatePayload,
  type SymbolUpdatePayload,
} from './signalr';

// ---------------------------------------------------------------------------
// SignalR — real-time streaming (MT5 v2 hub)
// ---------------------------------------------------------------------------
export {
  MT5V2SignalRClient,
  type MT5V2SignalRClientOptions,
  type MT5ConnectionStatusPayload,
  type MT5MarginCallPayload,
} from './signalr.mt5';
