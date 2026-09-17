// Per-call request context carried by generated RequestInit objects.
//
// Generated endpoint functions call customFetch(url, options). The client wrapper
// attaches this context to the final RequestInit object using a private Symbol,
// which survives generated object spreads without a process-global mutable slot.

import type { TokenProvider } from './auth';
import type { RetryPolicy } from './retry';
import type { ApiMeta } from './errors';

export interface RequestContext {
  apiBaseUrl: string;
  tokenProvider: TokenProvider;
  fetchImpl: typeof fetch;
  retryPolicy: RetryPolicy;
  timeoutMs: number;
}

/** Private symbol copied through generated object spreads. */
export const requestContext = Symbol('cplugin.webapi.request-context');
export type RequestInitWithContext = RequestInit & { [requestContext]?: RequestContext };

export function contextFromOptions(options: RequestInit): RequestContext {
  const ctx = (options as RequestInitWithContext)[requestContext];
  if (!ctx) throw new Error('No request context: call generated methods via CPluginWebApiClient.');
  return ctx;
}

/** Attach a client context without exposing it in serialized request options. */
export function withRequestContext(options: RequestInit | undefined, ctx: RequestContext): RequestInitWithContext {
  return { ...(options ?? {}), [requestContext]: ctx };
}

/** Metadata carried on array payloads returned by customFetch for paged(). */
export const responseMeta = Symbol('cplugin.webapi.response-meta');
export type ResponseWithMeta<T> = T & { [responseMeta]?: ApiMeta | null };