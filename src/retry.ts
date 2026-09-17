// Exponential-backoff retry layer for fetch-based operations.
//
// Retry eligibility:
//   - Thrown errors are eligible only for idempotent methods.
//   - 408, 429, 502, 503, 504 are eligible only when the request is idempotent.
//   - Other statuses are returned to the caller as-is.
//
// Idempotency is decided by the caller from the HTTP method. Unsafe POST/PATCH
// operations are never replayed merely because a header is present.

export interface RetryPolicy {
  maxAttempts: number;
  baseDelayMs: number;
  maxDelayMs: number;
  factor: number;
  jitterPercent: number;
}

export const defaultPolicy: RetryPolicy = {
  maxAttempts: 3,
  baseDelayMs: 500,
  maxDelayMs: 10_000,
  factor: 2.0,
  jitterPercent: 0.25,
};

const RETRYABLE_STATUSES = new Set([408, 429, 502, 503, 504]);

export interface WithRetryOptions {
  policy?: RetryPolicy;
  isIdempotent: boolean;
  signal?: AbortSignal;
}

export async function withRetry<T>(
  op: () => Promise<{ response: Response; result: T }>,
  opts: WithRetryOptions,
): Promise<{ response: Response; result: T }> {
  const policy = opts.policy ?? defaultPolicy;
  const { isIdempotent, signal } = opts;
  let attempt = 0;
  let lastResponse: { response: Response; result: T } | null = null;
  let lastError: unknown = null;

  while (attempt < policy.maxAttempts) {
    attempt++;
    throwIfAborted(signal);
    let outcome: { response: Response; result: T } | null = null;
    let thrown: unknown = null;
    try {
      outcome = await op();
    } catch (error) {
      thrown = error;
    }

    if (outcome) {
      lastResponse = outcome;
      lastError = null;
      if (!shouldRetryStatus(outcome.response.status, isIdempotent)) return outcome;
    } else {
      lastError = thrown;
      lastResponse = null;
      // Unsafe methods and all cancellation errors must fail immediately.
      if (!isIdempotent || isAbortLike(thrown) || signal?.aborted) break;
    }

    if (attempt >= policy.maxAttempts) break;
    await sleep(computeDelayMs({ attempt, policy, response: outcome?.response }), signal);
  }

  if (lastResponse) return lastResponse;
  throw lastError;
}

function isAbortLike(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  const value = error as { name?: unknown; code?: unknown };
  return value.name === 'AbortError' || value.name === 'TimeoutError' || value.code === 'ABORT_ERR';
}

function shouldRetryStatus(status: number, isIdempotent: boolean): boolean {
  return isIdempotent && RETRYABLE_STATUSES.has(status);
}

function computeDelayMs(args: { attempt: number; policy: RetryPolicy; response: Response | undefined }): number {
  const { attempt, policy, response } = args;
  if (response) {
    const retryAfterMs = parseRetryAfter(response.headers.get('retry-after'));
    if (retryAfterMs !== null) return Math.min(retryAfterMs, policy.maxDelayMs);
  }
  const exp = policy.baseDelayMs * Math.pow(policy.factor, attempt - 1);
  const capped = Math.min(exp, policy.maxDelayMs);
  const jitter = (Math.random() - 0.5) * 2 * policy.jitterPercent;
  return Math.max(0, capped * (1 + jitter));
}

function parseRetryAfter(header: string | null): number | null {
  if (!header) return null;
  const trimmed = header.trim();
  if (trimmed === '') return null;
  if (/^\d+$/.test(trimmed)) return Number(trimmed) * 1000;
  const date = Date.parse(trimmed);
  if (Number.isNaN(date)) return null;
  return Math.max(0, date - Date.now());
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (!signal?.aborted) return;
  throw signal.reason ?? new DOMException('Aborted', 'AbortError');
}

function sleep(ms: number, signal: AbortSignal | undefined): Promise<void> {
  if (ms <= 0) {
    throwIfAborted(signal);
    return Promise.resolve();
  }
  return new Promise<void>((resolve, reject) => {
    let timer: ReturnType<typeof setTimeout>;
    const onAbort = (): void => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      reject(signal?.reason ?? new DOMException('Aborted', 'AbortError'));
    };
    timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    if (signal) {
      if (signal.aborted) onAbort();
      else signal.addEventListener('abort', onAbort, { once: true });
    }
  });
}
