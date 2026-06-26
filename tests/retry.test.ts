import { describe, expect, test } from 'bun:test';
import { defaultPolicy, withRetry, type RetryPolicy } from '../src/retry';

// Tests use a tiny baseDelayMs so retry waits don't pad the suite.
const fastPolicy: RetryPolicy = { ...defaultPolicy, baseDelayMs: 1, maxDelayMs: 50, jitterPercent: 0 };

function makeOp(scripts: Array<() => Promise<{ response: Response; result: unknown }>>): {
  op: () => Promise<{ response: Response; result: unknown }>;
  count: () => number;
} {
  let i = 0;
  return {
    op: async () => {
      const idx = i++;
      const script = scripts[idx];
      if (!script) throw new Error(`op called more than ${scripts.length} times (idx=${idx})`);
      return await script();
    },
    count: () => i,
  };
}

function statusResponse(status: number, headers: Record<string, string> = {}): Response {
  return new Response('', { status, headers });
}

describe('withRetry', () => {
  test('single transient 503 then 200 succeeds in two attempts', async () => {
    const { op, count } = makeOp([
      async () => ({ response: statusResponse(503), result: 'fail' }),
      async () => ({ response: statusResponse(200), result: 'ok' }),
    ]);
    const out = await withRetry(op, { policy: fastPolicy, isIdempotent: true });
    expect(out.response.status).toBe(200);
    expect(out.result).toBe('ok');
    expect(count()).toBe(2);
  });

  test('three consecutive 503 returns the last 503 (does not throw)', async () => {
    const { op, count } = makeOp([
      async () => ({ response: statusResponse(503), result: 'a' }),
      async () => ({ response: statusResponse(503), result: 'b' }),
      async () => ({ response: statusResponse(503), result: 'c' }),
    ]);
    const out = await withRetry(op, { policy: fastPolicy, isIdempotent: true });
    expect(out.response.status).toBe(503);
    expect(out.result).toBe('c');
    expect(count()).toBe(3);
  });

  test('429 with Retry-After: 2 delays for ~2 seconds', async () => {
    const { op } = makeOp([
      async () => ({ response: statusResponse(429, { 'Retry-After': '2' }), result: 'a' }),
      async () => ({ response: statusResponse(200), result: 'ok' }),
    ]);
    const start = Date.now();
    const out = await withRetry(op, {
      policy: { ...fastPolicy, maxDelayMs: 10_000 },
      isIdempotent: true,
    });
    const elapsed = Date.now() - start;
    expect(out.response.status).toBe(200);
    expect(elapsed).toBeGreaterThanOrEqual(1900);
    expect(elapsed).toBeLessThan(2500);
  }, 5000);

  test('400 is not retried (returned immediately)', async () => {
    const { op, count } = makeOp([
      async () => ({ response: statusResponse(400), result: 'bad' }),
    ]);
    const out = await withRetry(op, { policy: fastPolicy, isIdempotent: true });
    expect(out.response.status).toBe(400);
    expect(count()).toBe(1);
  });

  test('non-idempotent + 503 is not retried', async () => {
    const { op, count } = makeOp([
      async () => ({ response: statusResponse(503), result: 'fail' }),
    ]);
    const out = await withRetry(op, { policy: fastPolicy, isIdempotent: false });
    expect(out.response.status).toBe(503);
    expect(count()).toBe(1);
  });

  test('thrown network error on attempt 1, success on attempt 2', async () => {
    const { op, count } = makeOp([
      async () => {
        throw new TypeError('ECONNRESET');
      },
      async () => ({ response: statusResponse(200), result: 'ok' }),
    ]);
    const out = await withRetry(op, { policy: fastPolicy, isIdempotent: true });
    expect(out.response.status).toBe(200);
    expect(count()).toBe(2);
  });

  test('thrown network error on all attempts rethrows the last error', async () => {
    const err1 = new TypeError('first');
    const err2 = new TypeError('second');
    const err3 = new TypeError('third');
    const { op } = makeOp([
      async () => {
        throw err1;
      },
      async () => {
        throw err2;
      },
      async () => {
        throw err3;
      },
    ]);
    let caught: unknown = null;
    try {
      await withRetry(op, { policy: fastPolicy, isIdempotent: true });
    } catch (e) {
      caught = e;
    }
    expect(caught).toBe(err3);
  });

  test('AbortSignal fired between retries throws AbortError and stops further attempts', async () => {
    const ac = new AbortController();
    const { op, count } = makeOp([
      async () => {
        ac.abort();
        return { response: statusResponse(503), result: 'a' };
      },
      async () => ({ response: statusResponse(200), result: 'ok' }),
    ]);
    let caught: unknown = null;
    try {
      await withRetry(op, {
        policy: { ...fastPolicy, baseDelayMs: 1000 },
        isIdempotent: true,
        signal: ac.signal,
      });
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(DOMException);
    expect((caught as DOMException).name).toBe('AbortError');
    expect(count()).toBe(1);
  });

  test('502/504 are retried when idempotent', async () => {
    const { op, count } = makeOp([
      async () => ({ response: statusResponse(502), result: 'a' }),
      async () => ({ response: statusResponse(504), result: 'b' }),
      async () => ({ response: statusResponse(200), result: 'ok' }),
    ]);
    const out = await withRetry(op, { policy: fastPolicy, isIdempotent: true });
    expect(out.response.status).toBe(200);
    expect(count()).toBe(3);
  });

  test('408 retried only when idempotent', async () => {
    const idempotent = makeOp([
      async () => ({ response: statusResponse(408), result: 'a' }),
      async () => ({ response: statusResponse(200), result: 'ok' }),
    ]);
    const out1 = await withRetry(idempotent.op, { policy: fastPolicy, isIdempotent: true });
    expect(out1.response.status).toBe(200);
    expect(idempotent.count()).toBe(2);

    const nonIdempotent = makeOp([
      async () => ({ response: statusResponse(408), result: 'a' }),
    ]);
    const out2 = await withRetry(nonIdempotent.op, { policy: fastPolicy, isIdempotent: false });
    expect(out2.response.status).toBe(408);
    expect(nonIdempotent.count()).toBe(1);
  });
});
