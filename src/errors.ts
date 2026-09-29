// v2 envelope + typed error model.
//
// The server always returns HTTP 200 and signals failure in-envelope via a
// non-null `error` field. `ApiError` is thrown by the transport when that
// happens so callers do not have to branch on the envelope manually.

// ---------------------------------------------------------------------------
// V2 envelope types (new — used by orval-generated transport + CPluginWebApiClient)
// ---------------------------------------------------------------------------

// * Mirrors the spec enum exactly (includes MT5Error for the v2 surface).
//   tests/errors.test.ts fails when it drifts from the generated WebApiErrorCode.
/**
 * Envelope error codes.
 *
 * - `Timeout` — a read did not finish within the request timeout; nothing was changed, safe to repeat.
 * - `OutcomeUnknown` — a trade or change did not finish within the request timeout and may still be
 *   applied by the server; also returned while a request with the same `Idempotency-Key` is still
 *   running. Never repeat blindly: repeat with the same `Idempotency-Key`, or check the result first.
 * - `Busy` — refused before it was sent to the trading server; nothing was executed, safe to repeat.
 */
export type WebApiErrorCode =
  | 'Ok'
  | 'NoConnect'
  | 'Validation'
  | 'MT4Error'
  | 'Forbidden'
  | 'NotFound'
  | 'MT5Error'
  | 'Timeout'
  | 'OutcomeUnknown'
  | 'Busy'
  | 'Internal';

/**
 * Value of the `X-Request-Outcome` response header — set when the caller did not get the result:
 *
 * - `timeout` — a read ran out of time; nothing was changed.
 * - `unknown` — a trade or change ran out of time after it was sent; it may still be applied.
 * - `not-started` — refused before it was sent to the trading server; nothing was executed.
 * - `in-progress` — a request with the same `Idempotency-Key` is still running; this one was not executed.
 */
export type RequestOutcome = 'timeout' | 'unknown' | 'not-started' | 'in-progress';

const REQUEST_OUTCOMES: ReadonlySet<string> = new Set<RequestOutcome>(['timeout', 'unknown', 'not-started', 'in-progress']);

/** Parses an `X-Request-Outcome` header value; undefined when absent or not recognised. */
export function parseRequestOutcome(value: string | null | undefined): RequestOutcome | undefined {
  const normalized = value?.trim().toLowerCase();
  return normalized && REQUEST_OUTCOMES.has(normalized) ? (normalized as RequestOutcome) : undefined;
}

/** Response details the transport attaches to an `ApiError`. */
export interface ApiErrorDetails {
  /** `X-Request-Outcome` of the response. */
  outcome?: RequestOutcome | undefined;
  /** `X-Request-Timeout-Applied` of the response, in seconds. */
  appliedTimeout?: number | undefined;
}

export interface PagingMeta {
  // * Opaque continuation token; pass back as ?cursor=. Null when no more items.
  nextCursor?: string | null;
  hasMore: boolean;
}

export interface ApiMeta {
  // * W3C trace id for log/trace correlation (Seq/SigNoz).
  activityId?: string | null;
  // * Present only on paginated list responses; omitted otherwise.
  paging?: PagingMeta | null;
}

// * Wire shape of the envelope `error` object. `managerCode` is the raw
//   MT4/MT5 ResultCode (string for named members, number otherwise), or null.
export interface ApiErrorBody {
  code: WebApiErrorCode;
  managerCode?: string | number | null;
  message?: string | null;
}

export interface ApiEnvelope<T> {
  data?: T | null;
  error?: ApiErrorBody | null;
  meta?: ApiMeta | null;
}

export function codeForHttpStatus(status: number): Exclude<WebApiErrorCode, 'Ok'> {
  if (status === 401 || status === 403) return 'Forbidden';
  if (status === 404) return 'NotFound';
  return 'Internal';
}

// * Thrown when the envelope carries a non-null error. Public surface is
//   { code, description, activityId } per design; managerCode/status/outcome are extras.
export class ApiError extends Error {
  readonly code: WebApiErrorCode;
  readonly description: string | undefined;
  readonly activityId: string | undefined;
  readonly managerCode: string | number | undefined;
  readonly status: number;
  /** What happened to the request when it did not complete (`X-Request-Outcome`). */
  readonly outcome: RequestOutcome | undefined;
  /** Server timeout that was applied to the request, in seconds (`X-Request-Timeout-Applied`). */
  readonly appliedTimeout: number | undefined;

  constructor(body: ApiErrorBody, meta: ApiMeta | null | undefined, status: number, details?: ApiErrorDetails) {
    const desc = body.message ?? undefined;
    super(desc ?? `v2 error: ${body.code}`);
    this.name = 'ApiError';
    this.code = body.code;
    this.description = desc;
    this.activityId = meta?.activityId ?? undefined;
    this.managerCode = body.managerCode ?? undefined;
    this.status = status;
    this.outcome = details?.outcome;
    this.appliedTimeout = details?.appliedTimeout;
  }
}

/**
 * True when the server reports that the operation may still be applied, or that a request
 * with the same `Idempotency-Key` is still running. Do not repeat it blindly: repeat it with
 * the same `Idempotency-Key` (the server then returns the original result once it exists and
 * never executes it twice), or check the resulting state first.
 *
 * ! A client-side deadline abort or a network error on a POST/PATCH is equally uncertain,
 *   but it is not an `ApiError`, so this function returns false for it.
 */
export function isOutcomeUnknown(error: unknown): error is ApiError {
  return error instanceof ApiError && reportsOutcomeUnknown(error);
}

function reportsOutcomeUnknown(error: ApiError): boolean {
  return error.code === 'OutcomeUnknown' || error.outcome === 'unknown' || error.outcome === 'in-progress';
}

/**
 * True when the server reports that the request changed nothing and may be repeated as is:
 * `Busy` (refused before it was sent to the trading server) or `Timeout` (a read that ran
 * out of time). The SDK never repeats these automatically; the caller decides when.
 */
export function isRetryable(error: unknown): error is ApiError {
  if (!(error instanceof ApiError) || reportsOutcomeUnknown(error)) return false;
  return error.code === 'Busy' || error.code === 'Timeout'
    || error.outcome === 'not-started' || error.outcome === 'timeout';
}
