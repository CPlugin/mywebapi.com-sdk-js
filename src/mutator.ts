// customFetch — orval transport layer.
//
// orval (httpClient: 'fetch') generates endpoint functions that call
// customFetch(url, options) for every request. This module:
//   1. Resolves per-call context (base URL, token provider, retry policy,
//      injected fetch) from the nearest withContext scope.
//   2. Injects Authorization: Bearer <token>.
//   3. Passes the request through withRetry for 429/5xx handling.
//   4. Performs a 401-driven token refresh + single retry inside the retry op.
//   5. Writes envelope.meta to ctx.lastMeta for the paged accessor.
//   6. Unwraps the { data, error, meta } envelope — returns data or throws
//      ApiError.
//
// * withRetry expects op: () => Promise<{ response: Response, result: T }>.
//   We carry the raw Response as both `response` and `result` inside the op
//   so the retry logic can inspect the status code. After withRetry returns we
//   read the body from outcome.response.

import { ApiError, type ApiEnvelope } from './errors';
import { currentContext } from './mutator.context';
import { withRetry } from './retry';

// * Generated callers pass the envelope/ResponseSuccess type as T; at runtime we
//   return the unwrapped `data`, so the public return type must unwrap too.
//   If T carries a `data?` property the conditional resolves to NonNullable<data>.
//   For void/204 types that have no `data` field the conditional falls through to T,
//   which is harmless — those endpoints return undefined at runtime anyway.
//   This type is exported so client.ts can apply it at the bind() layer without
//   touching the generated files (which rely on customFetch returning Promise<T>).
export type UnwrapEnvelope<T> = T extends { data?: infer D } ? NonNullable<D> : T;

export async function customFetch<T>(url: string, options: RequestInit): Promise<T> {
  const ctx = currentContext();
  const fullUrl = url.startsWith('http') ? url : `${ctx.apiBaseUrl}${url}`;

  // * Normalize headers to a plain object so we can safely spread and augment.
  const headerObj: Record<string, string> = {};
  if (options.headers) {
    if (options.headers instanceof Headers) {
      options.headers.forEach((v, k) => { headerObj[k] = v; });
    } else if (Array.isArray(options.headers)) {
      for (const [k, v] of options.headers) headerObj[k] = v;
    } else {
      Object.assign(headerObj, options.headers);
    }
  }

  const method = (options.method ?? 'GET').toUpperCase();
  // * Detect whether an Idempotency-Key header is present (case-insensitive).
  const hasIdemKey = Object.keys(headerObj).some((h) => h.toLowerCase() === 'idempotency-key');
  // * Idempotent for retry purposes: GET/HEAD/PUT/DELETE always; POST/PATCH
  //   only when the caller supplied an Idempotency-Key.
  const isIdempotent =
    method === 'GET' || method === 'HEAD' || method === 'PUT' || method === 'DELETE' || hasIdemKey;

  // * Build a fetch closure that injects a fresh (or force-refreshed) token.
  const doFetch = async (forceRefresh: boolean): Promise<Response> => {
    const token = await ctx.tokenProvider.getToken(forceRefresh ? { forceRefresh: true } : undefined);
    const headers: Record<string, string> = {
      ...headerObj,
      Authorization: `Bearer ${token}`,
      Accept: 'application/json',
    };
    return ctx.fetchImpl(fullUrl, { ...options, headers });
  };

  // * withRetry requires op to return { response, result }. We carry Response
  //   in both slots — the retry logic only uses `response` to inspect status,
  //   and we re-read the body from outcome.response after the loop.
  // ! The 401-refresh retry is intentionally INSIDE the op so withRetry sees
  //   the final (post-refresh) response status for its own retry gate. This
  //   means a 401 triggers exactly one internal refresh+retry; if the second
  //   call also returns 401 withRetry will not retry it further (401 is not in
  //   RETRYABLE_STATUSES) and outcome.response will carry status 401.
  const outcome = await withRetry(
    async () => {
      let response = await doFetch(false);
      if (response.status === 401) response = await doFetch(true);
      return { response, result: response };
    },
    {
      policy: ctx.retryPolicy,
      isIdempotent,
      ...(options.signal ? { signal: options.signal as AbortSignal } : {}),
    },
  );

  const response = outcome.response;

  if (!response.ok) {
    // * Response is not 2xx. Read as text first so a non-JSON body (e.g. a
    //   plain "401 Unauthorized" from an upstream proxy) does not cause a
    //   SyntaxError from response.json(). Try to parse as an ApiEnvelope; if
    //   that fails, synthesize an ApiError from the HTTP status.
    const text = await response.text();
    try {
      const env = JSON.parse(text) as ApiEnvelope<T>;
      ctx.lastMeta = env.meta ?? null;
      if (env.error != null) throw new ApiError(env.error, env.meta, response.status);
      // * 2xx was expected but response.ok is false — envelope has no error
      //   field. Fall through and return data if present; if not, let the
      //   caller deal with the undefined return (edge case: non-standard body).
      return env.data as T;
    } catch (e) {
      // ! Re-throw ApiErrors we just constructed above; only swallow JSON
      //   parse failures (SyntaxError) and other unexpected parse errors.
      if (e instanceof ApiError) throw e;
      throw new ApiError(
        {
          code: response.status === 401 ? 'Forbidden' : 'Internal',
          message: `HTTP ${response.status}`,
        },
        null,
        response.status,
      );
    }
  }

  const envelope = (await response.json()) as ApiEnvelope<T>;

  // * Write meta before unwrapping so the paged accessor always sees it,
  //   even if we are about to throw.
  ctx.lastMeta = envelope.meta ?? null;

  if (envelope.error != null) {
    throw new ApiError(envelope.error, envelope.meta, response.status);
  }

  return envelope.data as T;
}
