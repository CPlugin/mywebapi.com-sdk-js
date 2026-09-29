// Shared authenticated transport used by generated endpoints and handwritten discovery.
//
// Every request carries its RequestContext explicitly. There is no process-global
// mutable fallback, so browser calls from multiple client instances remain isolated.

import { ApiError, codeForHttpStatus, parseRequestOutcome, type ApiEnvelope, type ApiErrorDetails, type ApiMeta } from './errors';
import { contextFromOptions, requestContext, responseMeta, type RequestContext } from './mutator.context';
import { withRetry } from './retry';
import { withDeadline } from './deadline';
import {
  planRequestTimeout,
  REQUEST_OUTCOME_HEADER,
  REQUEST_TIMEOUT_APPLIED_HEADER,
  setTimeoutHeader,
  type RequestOptions,
} from './request-timeout';

export type UnwrapEnvelope<T> = T extends { data?: infer D } ? NonNullable<D> : T;

type ResponseConsumer<T> = (response: Response, signal: AbortSignal) => Promise<T>;

export async function authenticatedFetch<T>(
  ctx: RequestContext,
  url: string,
  options: RequestOptions,
  consume: ResponseConsumer<T>,
): Promise<T> {
  const fullUrl = new URL(url, ctx.apiBaseUrl);
  const { requestTimeout, ...fetchOptions } = options;
  const requestOptions = fetchOptions as RequestInit & { [requestContext]?: RequestContext };
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
  // * Validated before anything is sent: an invalid per-call value rejects without a request.
  const plan = planRequestTimeout({
    method,
    url: fullUrl,
    headers: headerObj,
    perCall: requestTimeout,
    clientDefault: ctx.requestTimeout,
    timeoutMs: ctx.timeoutMs,
  });
  if (plan.send !== undefined) setTimeoutHeader(headerObj, plan.send);

  return withDeadline(plan.deadlineMs, options.signal, async (signal) => {
    const isIdempotent = method === 'GET' || method === 'HEAD' || method === 'OPTIONS' || method === 'PUT' || method === 'DELETE';

    const doFetch = async (forceRefresh: boolean): Promise<Response> => {
      const token = await ctx.tokenProvider.getToken({
        ...(forceRefresh ? { forceRefresh: true } : {}),
        signal,
      });
      return ctx.fetchImpl(fullUrl.toString(), {
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

export async function customFetch<T>(url: string, options: RequestOptions): Promise<T> {
  const ctx = contextFromOptions(options);
  return authenticatedFetch(ctx, url, options, async (response) => {
    const details = errorDetails(response);
    if (!response.ok) {
      const text = await response.text();
      try {
        const env = JSON.parse(text) as ApiEnvelope<T>;
        if (env.error != null) throw new ApiError(env.error, env.meta, response.status, details);
        throw new ApiError(
          { code: codeForHttpStatus(response.status), message: 'HTTP ' + response.status },
          env.meta ?? null,
          response.status,
          details,
        );
      } catch (error) {
        if (error instanceof ApiError) throw error;
        throw new ApiError(
          { code: codeForHttpStatus(response.status), message: 'HTTP ' + response.status },
          null,
          response.status,
          details,
        );
      }
    }

    const envelope = (await response.json()) as ApiEnvelope<T>;
    if (envelope.error != null) throw new ApiError(envelope.error, envelope.meta, response.status, details);
    return attachResponseMeta(envelope.data as T, envelope.meta);
  });
}

function errorDetails(response: Response): ApiErrorDetails {
  const applied = Number(response.headers.get(REQUEST_TIMEOUT_APPLIED_HEADER) ?? Number.NaN);
  return {
    outcome: parseRequestOutcome(response.headers.get(REQUEST_OUTCOME_HEADER)),
    appliedTimeout: Number.isFinite(applied) ? applied : undefined,
  };
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
