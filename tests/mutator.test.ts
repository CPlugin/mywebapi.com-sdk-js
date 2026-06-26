import { describe, expect, test } from 'bun:test';
import { customFetch } from '../src/mutator';
import { withContext, type RequestContext } from '../src/mutator.context';
import { ApiError } from '../src/errors';
import { StaticTokenProvider, type TokenProvider } from '../src/auth';
import { defaultPolicy } from '../src/retry';

const json = (b: unknown) =>
  new Response(JSON.stringify(b), { headers: { 'Content-Type': 'application/json' } });

function ctx(overrides: Partial<RequestContext>): RequestContext {
  return {
    apiBaseUrl: 'https://api.example',
    tokenProvider: new StaticTokenProvider('tok'),
    fetchImpl: overrides.fetchImpl ?? ((async () => json({})) as unknown as typeof fetch),
    retryPolicy: defaultPolicy,
    ...overrides,
  };
}

describe('customFetch envelope unwrap', () => {
  test('returns data on success', async () => {
    const fetchImpl = (async () =>
      json({ data: '2026-06-26T00:00:00Z', error: null, meta: { activityId: 'a1' } })) as unknown as typeof fetch;
    const result = await withContext(ctx({ fetchImpl }), () =>
      customFetch<string>('/api/v2/MT4/tp-1/ServerTime', { method: 'GET' }),
    );
    expect(result).toBe('2026-06-26T00:00:00Z');
  });

  test('throws ApiError when envelope.error is non-null', async () => {
    const fetchImpl = (async () =>
      json({
        data: null,
        error: { code: 'Forbidden', message: 'No access', managerCode: null },
        meta: { activityId: 'trace-42' },
      })) as unknown as typeof fetch;
    let caught: unknown;
    try {
      await withContext(ctx({ fetchImpl }), () =>
        customFetch<string>('/api/v2/MT4/tp-1/ServerTime', { method: 'GET' }),
      );
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(ApiError);
    const err = caught as ApiError;
    expect(err.code).toBe('Forbidden');
    expect(err.description).toBe('No access');
    expect(err.activityId).toBe('trace-42');
  });

  test('persistent 401 with non-JSON body throws ApiError (not SyntaxError)', async () => {
    // * Simulates an upstream proxy returning a plain-text 401 — e.g. "Unauthorized"
    //   with no JSON body. The transport must NOT let response.json() throw a
    //   SyntaxError; it must synthesise an ApiError with code 'Forbidden'.
    let calls = 0;
    const tp: TokenProvider = { async getToken() { return 'tok-stale'; } };
    const fetchImpl = (async () => {
      calls++;
      // * Always 401 with a plain-text body (no JSON envelope).
      return new Response('Unauthorized', { status: 401 });
    }) as unknown as typeof fetch;
    let caught: unknown;
    try {
      await withContext(ctx({ tokenProvider: tp, fetchImpl }), () =>
        customFetch<string>('/api/v2/MT4/tp-1/ServerTime', { method: 'GET' }),
      );
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(ApiError);
    const err = caught as ApiError;
    expect(err.code).toBe('Forbidden');
    expect(err.status).toBe(401);
    // * The transport retried once (token refresh), so fetchImpl was called twice.
    expect(calls).toBe(2);
  });

  test('401 forces token refresh and retries once', async () => {
    let apiCalls = 0;
    const tokens: string[] = [];
    const tp: TokenProvider = {
      async getToken(opts) {
        const t = opts?.forceRefresh ? 'tok-2' : 'tok-1';
        tokens.push(t);
        return t;
      },
    };
    const fetchImpl = (async (_url: RequestInfo | URL, init?: RequestInit) => {
      apiCalls++;
      const auth = (init?.headers as Record<string, string>)['Authorization'];
      if (apiCalls === 1) {
        expect(auth).toBe('Bearer tok-1');
        return new Response('unauthorized', { status: 401 });
      }
      expect(auth).toBe('Bearer tok-2');
      return json({ data: 'ok', error: null, meta: null });
    }) as unknown as typeof fetch;
    const result = await withContext(ctx({ tokenProvider: tp, fetchImpl }), () =>
      customFetch<string>('/api/v2/MT4/tp-1/ServerTime', { method: 'GET' }),
    );
    expect(result).toBe('ok');
    expect(apiCalls).toBe(2);
    expect(tokens).toContain('tok-2');
  });
});
