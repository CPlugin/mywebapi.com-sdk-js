// Server request timeouts: X-Request-Timeout header, validation, client deadline
// extension, outcome parsing, and the guarantee that writes are never repeated.

import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { CPluginWebApiClient } from '../src/client';
import { customFetch } from '../src/mutator';
import { withRequestContext, type RequestContext } from '../src/mutator.context';
import { ApiError, isOutcomeUnknown, isRetryable, parseRequestOutcome, type WebApiErrorCode } from '../src/errors';
import { StaticTokenProvider } from '../src/auth';
import { defaultPolicy } from '../src/retry';
import { WebApiErrorCode as GeneratedErrorCode } from '../src/generated/model/webApiErrorCode';
import {
  operationDefaultTimeout,
  planRequestTimeout,
  SERVER_ANSWER_MARGIN_MS,
  validateRequestTimeout,
  type RequestOptions,
} from '../src/request-timeout';
import { OPERATION_TIMEOUTS } from '../src/request-timeouts.generated';
import { extractTimeouts, OUTPUT_PATH, renderTimeouts, SPEC_PATH } from '../scripts/generate-request-timeouts';

const json = (body: unknown, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { headers: { 'Content-Type': 'application/json', ...headers } });

const ok = <T>(data: T) => json({ data, error: null, meta: { activityId: 'a1' } });

const failure = (code: WebApiErrorCode, headers: Record<string, string> = {}) =>
  json({ data: null, error: { code, managerCode: null, message: `${code} message` }, meta: { activityId: 'trace-1' } }, headers);

interface Captured { method: string; url: string; headers: Record<string, string>; body?: unknown }

function recorder(respond: (call: Captured) => Response | Promise<Response>) {
  const calls: Captured[] = [];
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const call: Captured = {
      method: init?.method ?? 'GET',
      url: String(input),
      headers: { ...(init?.headers as Record<string, string> | undefined) },
    };
    calls.push(call);
    return respond(call);
  }) as unknown as typeof fetch;
  return { calls, fetchImpl };
}

function ctx(fetchImpl: typeof fetch, overrides: Partial<RequestContext> = {}): RequestContext {
  return {
    apiBaseUrl: 'https://api.example',
    tokenProvider: new StaticTokenProvider('tok'),
    fetchImpl,
    retryPolicy: { ...defaultPolicy, baseDelayMs: 0, jitterPercent: 0 },
    timeoutMs: 30_000,
    ...overrides,
  };
}

function call<T>(context: RequestContext, url: string, options: RequestOptions): Promise<T> {
  return customFetch<T>(url, withRequestContext(options, context));
}

async function rejection(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  throw new Error('expected a rejection');
}

function header(captured: Captured, name: string): string | undefined {
  return Object.entries(captured.headers).find(([k]) => k.toLowerCase() === name.toLowerCase())?.[1];
}

// Client whose token endpoint is mocked; API calls go to `api`.
function clientWith(api: (call: Captured) => Response, init: { requestTimeout?: number; timeoutMs?: number } = {}) {
  const apiCalls: Captured[] = [];
  const fetchImpl = (async (input: RequestInfo | URL, reqInit?: RequestInit) => {
    const url = String(input);
    if (url.includes('/.well-known/openid-configuration')) {
      return json({ token_endpoint: 'https://pre.auth.cplugin.net/connect/token', issuer: 'https://pre.auth.cplugin.net' });
    }
    if (url.endsWith('/connect/token')) return json({ access_token: 'tok', expires_in: 3600 });
    const captured: Captured = {
      method: reqInit?.method ?? 'GET',
      url,
      headers: { ...(reqInit?.headers as Record<string, string> | undefined) },
      body: reqInit?.body,
    };
    apiCalls.push(captured);
    return api(captured);
  }) as unknown as typeof fetch;
  const client = new CPluginWebApiClient({ env: 'staging', clientId: 'cid', clientSecret: 'csec', fetch: fetchImpl, ...init });
  return { client, apiCalls };
}

describe('generated timeout table', () => {
  test('matches spec/v2.json (run `bun run generate` after a spec update)', () => {
    const spec = JSON.parse(readFileSync(SPEC_PATH, 'utf8'));
    expect(readFileSync(OUTPUT_PATH, 'utf8')).toBe(renderTimeouts(extractTimeouts(spec)));
  });

  test('knows the per-kind server defaults', () => {
    expect(operationDefaultTimeout('GET', '/api/v2/MT4/tp-1/ServerTime')).toBe(10);
    expect(operationDefaultTimeout('POST', '/api/v2/MT4/tp-1/TradeTransaction')).toBe(5);
    expect(operationDefaultTimeout('PATCH', '/api/v2/MT4/tp-1/UserRecord/817542')).toBe(15);
    // * Case-insensitive like the server's routing; encoded platform ids are one segment.
    expect(operationDefaultTimeout('get', '/api/v2/mt4/a%2Fb/servertime')).toBe(10);
  });

  test('operations without a server timeout have no default', () => {
    expect(operationDefaultTimeout('GET', '/api/TradePlatforms')).toBeUndefined();
    expect(operationDefaultTimeout('GET', '/api/v2/MT4/tp-1/PluginsGet')).toBeUndefined();
    expect(operationDefaultTimeout('DELETE', '/api/v2/MT4/tp-1/ServerTime')).toBeUndefined();
  });

  test('hand-maintained WebApiErrorCode matches the generated enum', () => {
    const handWritten: Record<WebApiErrorCode, true> = {
      Ok: true, NoConnect: true, Validation: true, MT4Error: true, Forbidden: true, NotFound: true,
      MT5Error: true, Timeout: true, OutcomeUnknown: true, Busy: true, Internal: true,
    };
    expect(Object.keys(handWritten).sort()).toEqual(Object.values(GeneratedErrorCode).sort());
  });
});

describe('requestTimeout validation', () => {
  test.each([1, 2.5, 300])('accepts %p seconds', (seconds) => {
    expect(validateRequestTimeout(seconds)).toBe(seconds);
  });

  test.each([0, 0.5, 300.5, -1, Number.NaN, Number.POSITIVE_INFINITY, '10' as unknown as number])(
    'rejects %p',
    (seconds) => {
      expect(() => validateRequestTimeout(seconds)).toThrow(TypeError);
    },
  );

  test('an invalid per-call value rejects before any request is sent', async () => {
    const { calls, fetchImpl } = recorder(() => ok('x'));
    const error = await rejection(call(ctx(fetchImpl), '/api/v2/MT4/tp-1/ServerTime', { method: 'GET', requestTimeout: 0 }));
    expect(error).toBeInstanceOf(TypeError);
    expect(calls).toHaveLength(0);
  });

  test('an invalid client-wide value throws from the constructor', () => {
    expect(() => new CPluginWebApiClient({ env: 'staging', clientId: 'c', clientSecret: 's', requestTimeout: 301 })).toThrow(TypeError);
  });
});

describe('X-Request-Timeout header', () => {
  test('per-call requestTimeout is sent and not leaked into RequestInit', async () => {
    let init: (RequestInit & { requestTimeout?: unknown }) | undefined;
    const fetchImpl = (async (_input: RequestInfo | URL, reqInit?: RequestInit) => {
      init = reqInit;
      return ok('x');
    }) as unknown as typeof fetch;
    await call(ctx(fetchImpl), '/api/v2/MT4/tp-1/ServerTime', { method: 'GET', requestTimeout: 2.5 });
    expect((init?.headers as Record<string, string>)['X-Request-Timeout']).toBe('2.5');
    expect(init && 'requestTimeout' in init).toBe(false);
  });

  test('typed per-call option on generated methods, overriding the client default', async () => {
    const { client, apiCalls } = clientWith(() => ok('2026-09-29T00:00:00Z'), { requestTimeout: 20 });
    await client.mt4.getServerTime('tp-1', { requestTimeout: 3 });
    await client.mt4.getServerTime('tp-1');
    expect(header(apiCalls[0]!, 'X-Request-Timeout')).toBe('3');
    expect(header(apiCalls[1]!, 'X-Request-Timeout')).toBe('20');
  });

  test('PATCH sends the patch object as JSON together with the timeout header', async () => {
    const { client, apiCalls } = clientWith(() => ok({ login: 817542 }));
    await client.mt4.patchUserRecordLogin('tp-1', 817542, { comment: 'updated' }, { requestTimeout: 20 });
    const sent = apiCalls[0]!;
    expect(sent.method).toBe('PATCH');
    expect(header(sent, 'Content-Type')).toBe('application/json');
    expect(header(sent, 'X-Request-Timeout')).toBe('20');
    expect(JSON.parse(String(sent.body))).toEqual({ comment: 'updated' });
  });

  test('client default is not sent to operations without a server timeout', async () => {
    const { client, apiCalls } = clientWith(() => ok([]), { requestTimeout: 20 });
    await client.mt4.getPluginsGet('tp-1');
    expect(header(apiCalls[0]!, 'X-Request-Timeout')).toBeUndefined();
  });

  test('per-call value replaces a hand-set header of any case', async () => {
    const { calls, fetchImpl } = recorder(() => ok('x'));
    await call(ctx(fetchImpl), '/api/v2/MT4/tp-1/ServerTime', {
      method: 'GET',
      headers: { 'x-request-timeout': '99' },
      requestTimeout: 7,
    });
    expect(Object.keys(calls[0]!.headers).filter((k) => k.toLowerCase() === 'x-request-timeout')).toEqual(['X-Request-Timeout']);
    expect(header(calls[0]!, 'X-Request-Timeout')).toBe('7');
  });

  test('without any value the header is omitted and the server default applies', async () => {
    const { calls, fetchImpl } = recorder(() => ok('x'));
    await call(ctx(fetchImpl), '/api/v2/MT4/tp-1/ServerTime', { method: 'GET' });
    expect(header(calls[0]!, 'X-Request-Timeout')).toBeUndefined();
  });
});

describe('client deadline outlasts the server timeout', () => {
  const plan = (method: string, path: string, extra: Partial<Parameters<typeof planRequestTimeout>[0]> = {}) =>
    planRequestTimeout({
      method,
      url: new URL(path, 'https://api.example'),
      headers: {},
      perCall: undefined,
      clientDefault: undefined,
      timeoutMs: 30_000,
      ...extra,
    });

  test('margin covers the server connect allowance (20 s) plus transfer, as in the other SDKs', () => {
    expect(SERVER_ANSWER_MARGIN_MS).toBe(30_000);
  });

  test('requested timeout + margin when longer than timeoutMs', () => {
    expect(plan('POST', '/api/v2/MT4/tp-1/TradeTransaction', { perCall: 120 }).deadlineMs).toBe(120_000 + SERVER_ANSWER_MARGIN_MS);
    expect(plan('GET', '/api/v2/MT4/tp-1/ServerTime', { clientDefault: 45 }).deadlineMs).toBe(45_000 + SERVER_ANSWER_MARGIN_MS);
  });

  test('operation default covers history (30 s) and maintenance (60 s) calls', () => {
    const history = sampleOperation('GET', 30);
    const maintenance = sampleOperation('POST', 60);
    expect(plan(history[0], history[1]).deadlineMs).toBe(30_000 + SERVER_ANSWER_MARGIN_MS);
    expect(plan(maintenance[0], maintenance[1]).deadlineMs).toBe(60_000 + SERVER_ANSWER_MARGIN_MS);
  });

  test('timeoutMs stays the floor', () => {
    expect(plan('GET', '/api/v2/MT4/tp-1/ServerTime', { timeoutMs: 90_000 }).deadlineMs).toBe(90_000);
    expect(plan('GET', '/api/v2/MT4/tp-1/ServerTime', { perCall: 1, timeoutMs: 90_000 }).deadlineMs).toBe(90_000);
    expect(plan('GET', '/api/TradePlatforms', { timeoutMs: 5_000 }).deadlineMs).toBe(5_000);
  });

  test('hand-set header or query value is honoured for the deadline', () => {
    expect(plan('GET', '/api/v2/MT4/tp-1/ServerTime', { headers: { 'X-Request-Timeout': '100' } }).deadlineMs).toBe(100_000 + SERVER_ANSWER_MARGIN_MS);
    expect(plan('GET', '/api/v2/MT4/tp-1/ServerTime?requestTimeout=50').deadlineMs).toBe(50_000 + SERVER_ANSWER_MARGIN_MS);
  });

  test('a slow answer inside the server timeout is not cut off by a short timeoutMs', async () => {
    const slow = () => new Promise<Response>((resolve) => setTimeout(() => resolve(ok('late')), 150));
    const guarded = recorder(slow);
    await expect(
      call(ctx(guarded.fetchImpl, { timeoutMs: 50 }), '/api/v2/MT4/tp-1/ServerTime', { method: 'GET', requestTimeout: 1 }),
    ).resolves.toBe('late');

    // * Control: an operation without a server timeout keeps the 50 ms deadline.
    const unguarded = (async (_input: RequestInfo | URL, init?: RequestInit) =>
      new Promise<Response>((resolve, reject) => {
        const timer = setTimeout(() => resolve(ok([])), 150);
        init?.signal?.addEventListener('abort', () => { clearTimeout(timer); reject(init.signal?.reason); });
      })) as unknown as typeof fetch;
    const error = await rejection(call(ctx(unguarded, { timeoutMs: 50 }), '/api/v2/MT4/tp-1/PluginsGet', { method: 'GET' }));
    expect((error as { name?: string }).name).toBe('TimeoutError');
  });
});

describe('ApiError outcome', () => {
  test('carries X-Request-Outcome and X-Request-Timeout-Applied', async () => {
    const { fetchImpl } = recorder(() =>
      failure('OutcomeUnknown', { 'X-Request-Outcome': 'unknown', 'X-Request-Timeout-Applied': '5' }));
    const error = await rejection(call(ctx(fetchImpl), '/api/v2/MT4/tp-1/TradeTransaction', { method: 'POST', body: '{}' }));
    expect(error).toBeInstanceOf(ApiError);
    const apiError = error as ApiError;
    expect(apiError.code).toBe('OutcomeUnknown');
    expect(apiError.outcome).toBe('unknown');
    expect(apiError.appliedTimeout).toBe(5);
    expect(apiError.activityId).toBe('trace-1');
    expect(isOutcomeUnknown(apiError)).toBe(true);
    expect(isRetryable(apiError)).toBe(false);
  });

  test('outcome header parsing', () => {
    expect(parseRequestOutcome(' In-Progress ')).toBe('in-progress');
    expect(parseRequestOutcome('not-started')).toBe('not-started');
    expect(parseRequestOutcome('something-else')).toBeUndefined();
    expect(parseRequestOutcome(null)).toBeUndefined();
  });

  test('classification helpers', () => {
    const make = (code: WebApiErrorCode, outcome?: 'timeout' | 'unknown' | 'not-started' | 'in-progress') =>
      new ApiError({ code, message: code }, null, 200, { outcome });
    expect(isRetryable(make('Busy', 'not-started'))).toBe(true);
    expect(isRetryable(make('Timeout', 'timeout'))).toBe(true);
    expect(isRetryable(make('OutcomeUnknown', 'in-progress'))).toBe(false);
    expect(isOutcomeUnknown(make('OutcomeUnknown', 'in-progress'))).toBe(true);
    expect(isOutcomeUnknown(make('Timeout', 'timeout'))).toBe(false);
    expect(isRetryable(make('MT4Error'))).toBe(false);
    expect(isRetryable(new Error('network'))).toBe(false);
    expect(isOutcomeUnknown(new DOMException('x', 'TimeoutError'))).toBe(false);
  });

  test('errors without the headers leave outcome undefined', () => {
    const error = new ApiError({ code: 'Forbidden' }, null, 200);
    expect(error.outcome).toBeUndefined();
    expect(error.appliedTimeout).toBeUndefined();
  });
});

describe('no automatic repetition of uncertain or refused requests', () => {
  test.each([
    ['OutcomeUnknown', 'unknown'],
    ['OutcomeUnknown', 'in-progress'],
    ['Busy', 'not-started'],
  ] as const)('POST answered %s (%s) is sent exactly once', async (code, outcome) => {
    const { calls, fetchImpl } = recorder(() => failure(code, { 'X-Request-Outcome': outcome }));
    const error = await rejection(call(ctx(fetchImpl), '/api/v2/MT4/tp-1/TradeTransaction', {
      method: 'POST',
      headers: { 'Idempotency-Key': 'k-1' },
      body: '{}',
    }));
    expect((error as ApiError).code).toBe(code);
    expect(calls).toHaveLength(1);
  });

  test('POST/PATCH network error is sent exactly once', async () => {
    for (const method of ['POST', 'PATCH']) {
      const { calls, fetchImpl } = recorder(() => { throw new TypeError('socket hang up'); });
      const error = await rejection(call(ctx(fetchImpl), '/api/v2/MT4/tp-1/UserRecord/1', { method, body: '{}' }));
      expect(error).toBeInstanceOf(TypeError);
      expect(calls).toHaveLength(1);
    }
  });

  test('GET envelope Timeout / Busy are returned to the caller, not repeated', async () => {
    for (const [code, outcome] of [['Timeout', 'timeout'], ['Busy', 'not-started']] as const) {
      const { calls, fetchImpl } = recorder(() => failure(code, { 'X-Request-Outcome': outcome }));
      const error = await rejection(call(ctx(fetchImpl), '/api/v2/MT4/tp-1/ServerTime', { method: 'GET' }));
      expect(isRetryable(error)).toBe(true);
      expect(calls).toHaveLength(1);
    }
  });

  test('GET transient HTTP 503 keeps the existing retry policy', async () => {
    let n = 0;
    const { calls, fetchImpl } = recorder(() => (++n === 1 ? new Response('', { status: 503 }) : ok('x')));
    await expect(call(ctx(fetchImpl), '/api/v2/MT4/tp-1/ServerTime', { method: 'GET', requestTimeout: 2 })).resolves.toBe('x');
    expect(calls).toHaveLength(2);
    expect(calls.every((c) => header(c, 'X-Request-Timeout') === '2')).toBe(true);
  });
});

// * First operation in the generated table with the given method and default.
function sampleOperation(method: string, seconds: number): [string, string] {
  const found = OPERATION_TIMEOUTS.find(([m, , s]) => m === method && s === seconds);
  if (!found) throw new Error(`no ${method} operation with a ${seconds} s default`);
  return [found[0], found[1].replace('{tradePlatform}', 'tp-1').replace(/\{[^}]+\}/g, '1')];
}
