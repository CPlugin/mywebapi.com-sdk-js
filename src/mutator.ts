// Shared authenticated transport used by generated endpoints and handwritten discovery.
//
// Every request carries its RequestContext explicitly. There is no process-global
// mutable fallback, so browser calls from multiple client instances remain isolated.

import { ApiError, codeForHttpStatus, type ApiEnvelope, type ApiMeta } from './errors';
import { contextFromOptions, requestContext, responseMeta, type RequestContext } from './mutator.context';
import { withRetry } from './retry';
import { withDeadline } from './deadline';

export type UnwrapEnvelope<T> = T extends { data?: infer D } ? NonNullable<D> : T;

type ResponseConsumer<T> = (response: Response, signal: AbortSignal) => Promise<T>;

export async function authenticatedFetch<T>(
  ctx: RequestContext,
  url: string,
  options: RequestInit,
  consume: ResponseConsumer<T>,
): Promise<T> {
  return withDeadline(ctx.timeoutMs, options.signal, async (signal) => {
    const fullUrl = new URL(url, ctx.apiBaseUrl).toString();
    const requestOptions = { ...options } as RequestInit & { [requestContext]?: RequestContext };
    delete requestOptions[requestContext];

    const headerObj: Record<string, string> = {};
    if (options.headers) {
      if (options.headers instanceof Headers) {
        options.headers.forEach((value, key) => { headerObj[key] = value; });
      } else if (Array.isArray(options.headers)) {
        for (const [key, value] of options.headers) headerObj[key] = value;
      } else {
        Object.assign(headerObj, options.headers);
      }
    }

    const method = (options.method ?? 'GET').toUpperCase();
    const isIdempotent = method === 'GET' || method === 'HEAD' || method === 'OPTIONS' || method === 'PUT' || method === 'DELETE';

    const doFetch = async (forceRefresh: boolean): Promise<Response> => {
      const token = await ctx.tokenProvider.getToken({
        ...(forceRefresh ? { forceRefresh: true } : {}),
        signal,
      });
      return ctx.fetchImpl(fullUrl, {
        ...requestOptions,
        method,
        headers: {
          ...headerObj,
          Authorization: 'Bearer ' + token,
          Accept: 'application/json',
        },
        signal,
        redirect: 'error',
      });
    };

    const outcome = await withRetry(
      async () => {
        let response = await doFetch(false);
        if (response.status === 401 && isIdempotent) response = await doFetch(true);
        return { response, result: response };
      },
      { policy: ctx.retryPolicy, isIdempotent, signal },
    );
    return consume(outcome.response, signal);
  });
}

export async function customFetch<T>(url: string, options: RequestInit): Promise<T> {
  const ctx = contextFromOptions(options);
  return authenticatedFetch(ctx, url, options, async (response, signal) => {
    if (!response.ok) {
      const text = await response.text();
      try {
        const env = JSON.parse(text) as ApiEnvelope<T>;
        if (env.error != null) throw new ApiError(env.error, env.meta, response.status);
        throw new ApiError(
          { code: codeForHttpStatus(response.status), message: 'HTTP ' + response.status },
          env.meta ?? null,
          response.status,
        );
      } catch (error) {
        if (error instanceof ApiError) throw error;
        throw new ApiError(
          { code: codeForHttpStatus(response.status), message: 'HTTP ' + response.status },
          null,
          response.status,
        );
      }
    }

    const envelope = (await response.json()) as ApiEnvelope<T>;
    if (envelope.error != null) throw new ApiError(envelope.error, envelope.meta, response.status);
    return attachResponseMeta(envelope.data as T, envelope.meta);
  });
}

function attachResponseMeta<T>(data: T, meta: ApiMeta | null | undefined): T {
  if (data !== null && (typeof data === 'object' || typeof data === 'function')) {
    Object.defineProperty(data, responseMeta, { value: meta ?? null, enumerable: false, configurable: true });
  }
  return data;
}

export function pagingFromResult<T>(items: T): ApiMeta | null {
  if (items !== null && (typeof items === 'object' || typeof items === 'function')) {
    return (items as { [responseMeta]?: ApiMeta | null })[responseMeta] ?? null;
  }
  return null;
}
