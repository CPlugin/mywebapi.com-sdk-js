// Per-call request context propagated to customFetch via AsyncLocalStorage.
//
// orval-generated endpoint functions call customFetch(url, options) with no
// client instance reference. CPluginWebApiClient wraps every generated call in
// withContext(ctx, fn) so customFetch can read the live context via
// currentContext() without coupling to a specific client object.
//
// * AsyncLocalStorage isolates per-call context on Node/Bun. A synchronous
//   module-level fallback handles runtimes that lack async_hooks — the client
//   sets it immediately before the awaited call, in the same microtask.

import { AsyncLocalStorage } from 'node:async_hooks';
import type { TokenProvider } from './auth';
import type { RetryPolicy } from './retry';
import type { ApiMeta } from './errors';

export interface RequestContext {
  apiBaseUrl: string;
  tokenProvider: TokenProvider;
  fetchImpl: typeof fetch;
  retryPolicy: RetryPolicy;
  // * Side-channel for pagination: customFetch writes the last response's meta
  //   here so the client's paged accessor can read the cursor that
  //   envelope-unwrap drops.
  lastMeta?: ApiMeta | null;
}

const store = new AsyncLocalStorage<RequestContext>();
let fallback: RequestContext | null = null;

// * Run fn inside an AsyncLocalStorage scope carrying ctx. The fallback slot
//   is also written for runtimes where getStore() returns undefined.
export function withContext<T>(ctx: RequestContext, fn: () => Promise<T>): Promise<T> {
  fallback = ctx;
  return store.run(ctx, fn);
}

// * Read the context set by the nearest enclosing withContext call.
// ! Throws if called outside a withContext scope (should never happen when
//   the generated client is used through CPluginWebApiClient).
export function currentContext(): RequestContext {
  const ctx = store.getStore() ?? fallback;
  if (!ctx) throw new Error('No request context: call generated methods via CPluginWebApiClient.');
  return ctx;
}

// * Non-throwing variant — returns the active context or null.
//   Used by bind() to detect whether a call is already nested inside an
//   active withContext scope (e.g. inside paged()) so it can reuse the outer
//   scope rather than creating a fresh per-call context that would isolate
//   lastMeta.
// ! Intentionally does NOT fall back to the module-level `fallback` variable.
//   The fallback persists after a call completes (it is never cleared) so it
//   would incorrectly signal "nested" to subsequent top-level calls. Only the
//   AsyncLocalStorage store reliably tracks live scopes. The fallback is only
//   meaningful for currentContext() on runtimes that lack async_hooks.
export function currentContextOrNull(): RequestContext | null {
  return store.getStore() ?? null;
}
