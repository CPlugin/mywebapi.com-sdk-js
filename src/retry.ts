// Exponential-backoff retry layer for fetch-based operations.
//
// Retry eligibility (mirrors AWS / Google / Stripe conventions):
//   - Thrown errors from `op()` (network failures, DNS, TLS): always eligible.
//   - 429, 502, 503, 504: eligible only if the request is idempotent.
//   - 408: eligible only if idempotent (RFC 7231 §6.5.7 — client may retry).
//   - Other 4xx / 2xx / 3xx: returned to the caller as-is.
//
// Idempotency must be decided by the caller (GET/HEAD/PUT/DELETE are idempotent
// by HTTP spec; POST/PATCH are idempotent only when an Idempotency-Key is set).
//
// After exhaustion: if the last attempt produced a Response, return it (caller
// decides on the status); if it threw, rethrow the original error.

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

const RETRYABLE_STATUSES = new Set([429, 502, 503, 504]);
const IDEMPOTENT_ONLY_STATUSES = new Set([408]);

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
  // Track the most recent outcome so we can return it after exhausting attempts
  // without re-running the op or losing the Response body.
  let lastResponse: { response: Response; result: T } | null = null;
  let lastError: unknown = null;

  while (attempt < policy.maxAttempts) {
    attempt++;
    throwIfAborted(signal);

    let outcome: { response: Response; result: T } | null = null;
    let thrown: unknown = null;
    try {
      outcome = await op();
    } catch (err) {
      thrown = err;
    }

    if (outcome) {
      lastResponse = outcome;
      lastError = null;
      if (!shouldRetryStatus(outcome.response.status, isIdempotent)) {
        return outcome;
      }
    } else {
      lastError = thrown;
      lastResponse = null;
    }

    if (attempt >= policy.maxAttempts) break;

    const delayMs = computeDelayMs({
      attempt,
      policy,
      response: outcome?.response,
    });
    await sleep(delayMs, signal);
  }

  if (lastResponse) return lastResponse;
  throw lastError;
}

function shouldRetryStatus(status: number, isIdempotent: boolean): boolean {
  if (RETRYABLE_STATUSES.has(status)) return isIdempotent;
  if (IDEMPOTENT_ONLY_STATUSES.has(status)) return isIdempotent;
  return false;
}

function computeDelayMs(args: { attempt: number; policy: RetryPolicy; response: Response | undefined }): number {
  const { attempt, policy, response } = args;
  if (response) {
    const retryAfterMs = parseRetryAfter(response.headers.get('retry-after'));
    if (retryAfterMs !== null) {
      return Math.min(retryAfterMs, policy.maxDelayMs);
    }
  }
  const exp = policy.baseDelayMs * Math.pow(policy.factor, attempt - 1);
  const capped = Math.min(exp, policy.maxDelayMs);
  // Symmetric jitter: ±jitterPercent. (random()-0.5)*2 yields [-1, 1].
  const jitter = (Math.random() - 0.5) * 2 * policy.jitterPercent;
  return Math.max(0, capped * (1 + jitter));
}

// RFC 7231 §7.1.3: Retry-After is either a non-negative integer (delta-seconds)
// or an HTTP-date. Returns ms, or null if header is absent/unparseable.
function parseRetryAfter(header: string | null): number | null {
  if (!header) return null;
  const trimmed = header.trim();
  if (trimmed === '') return null;
  if (/^\d+$/.test(trimmed)) {
    return Number(trimmed) * 1000;
  }
  const date = Date.parse(trimmed);
  if (Number.isNaN(date)) return null;
  return Math.max(0, date - Date.now());
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (!signal?.aborted) return;
  if (signal.reason !== undefined) throw signal.reason;
  throw new DOMException('Aborted', 'AbortError');
}

function sleep(ms: number, signal: AbortSignal | undefined): Promise<void> {
  if (ms <= 0) {
    throwIfAborted(signal);
    return Promise.resolve();
  }
  return new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = (): void => {
      clearTimeout(timer);
      const reason = signal?.reason ?? new DOMException('Aborted', 'AbortError');
      reject(reason);
    };
    if (signal) {
      if (signal.aborted) {
        clearTimeout(timer);
        reject(signal.reason ?? new DOMException('Aborted', 'AbortError'));
        return;
      }
      signal.addEventListener('abort', onAbort, { once: true });
    }
  });
}
