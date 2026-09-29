// Server-side request timeouts (X-Request-Timeout) and the matching client deadline.
//
// The server bounds every trade-platform call with a per-operation timeout (trade 5 s,
// read 10 s, change 15 s, history 30 s, maintenance 60 s) that a caller may change per
// request. When it expires the server answers with Timeout / OutcomeUnknown / Busy —
// a definitive statement about what happened. The client deadline must therefore
// outlast the server timeout; otherwise the caller gets a local abort and loses that
// statement, which for a trade means not knowing whether it was executed.

import {
  OPERATION_TIMEOUTS,
  REQUEST_TIMEOUT_MAX_SECONDS,
  REQUEST_TIMEOUT_MIN_SECONDS,
} from './request-timeouts.generated';

export { REQUEST_TIMEOUT_MAX_SECONDS, REQUEST_TIMEOUT_MIN_SECONDS };

export const REQUEST_TIMEOUT_HEADER = 'X-Request-Timeout';
export const REQUEST_TIMEOUT_QUERY = 'requestTimeout';
export const REQUEST_TIMEOUT_APPLIED_HEADER = 'X-Request-Timeout-Applied';
export const REQUEST_OUTCOME_HEADER = 'X-Request-Outcome';

/**
 * Time the client waits beyond the server timeout for the server's answer to arrive.
 *
 * ! The server extends its own deadline by the time it spends opening the trading
 *   platform connection for this very request, up to 20 s (cold start); the remaining
 *   10 s cover response transfer and queueing in front of the API. Same margin as the
 *   other CPlugin WebAPI SDKs.
 */
export const SERVER_ANSWER_MARGIN_MS = 30_000;

/** Per-call options accepted by every generated endpoint method as its last argument. */
export interface RequestOptions extends RequestInit {
  /**
   * How long the server waits for the trading platform, in seconds
   * (1–300, fractions allowed). Sent as the `X-Request-Timeout` header and overrides
   * the client-wide `requestTimeout`. Omit to use the operation's server default.
   * The client deadline is extended automatically so the server's answer is received.
   */
  requestTimeout?: number;
}

/** Throws a TypeError unless `seconds` is a value the server accepts. */
export function validateRequestTimeout(seconds: unknown, name = 'requestTimeout'): number {
  if (typeof seconds !== 'number' || !Number.isFinite(seconds)
    || seconds < REQUEST_TIMEOUT_MIN_SECONDS || seconds > REQUEST_TIMEOUT_MAX_SECONDS) {
    throw new TypeError(
      `${name} must be a number of seconds from ${REQUEST_TIMEOUT_MIN_SECONDS} to ${REQUEST_TIMEOUT_MAX_SECONDS}`,
    );
  }
  return seconds;
}

// * Route templates compiled once: segment arrays per method, `null` for a {param} segment.
interface CompiledRoute {
  segments: Array<string | null>;
  staticCount: number;
  seconds: number;
}

const ROUTES = new Map<string, CompiledRoute[]>();
for (const [method, path, seconds] of OPERATION_TIMEOUTS) {
  const segments = path.split('/').filter(Boolean).map((s) => (s.startsWith('{') ? null : s.toLowerCase()));
  const list = ROUTES.get(method) ?? [];
  list.push({ segments, staticCount: segments.filter((s) => s !== null).length, seconds });
  ROUTES.set(method, list);
}

/**
 * Server default timeout, in seconds, of the operation addressed by `method` + `pathname`,
 * or `undefined` when the operation is not guarded by a server timeout.
 */
export function operationDefaultTimeout(method: string, pathname: string): number | undefined {
  const candidates = ROUTES.get(method.toUpperCase());
  if (!candidates) return undefined;
  const segments = pathname.split('/').filter(Boolean).map((s) => s.toLowerCase());
  let best: CompiledRoute | undefined;
  for (const route of candidates) {
    if (route.segments.length !== segments.length) continue;
    if (!route.segments.every((s, i) => s === null || s === segments[i])) continue;
    // * A literal segment beats a {param} segment at the same position.
    if (!best || route.staticCount > best.staticCount) best = route;
  }
  return best?.seconds;
}

/** Parses a caller-supplied header or query value the way the server does; undefined when unusable. */
function parseSeconds(value: string | null | undefined): number | undefined {
  if (value == null || value.trim() === '') return undefined;
  const seconds = Number(value.trim());
  return Number.isFinite(seconds) && seconds > 0 ? seconds : undefined;
}

export interface TimeoutPlan {
  /** Value to send as X-Request-Timeout, or undefined to leave the headers as they are. */
  send: number | undefined;
  /** Client deadline for the whole operation, in milliseconds. */
  deadlineMs: number;
}

/**
 * Decides which X-Request-Timeout to send and how long the client waits.
 *
 * Precedence of the server timeout: per-call `requestTimeout` → an `X-Request-Timeout`
 * header or `requestTimeout` query value the caller set by hand → the client-wide
 * default (only for operations that accept it) → the operation's server default.
 * The deadline is `max(timeoutMs, serverTimeout + SERVER_ANSWER_MARGIN_MS)`.
 */
export function planRequestTimeout(args: {
  method: string;
  url: URL;
  headers: Record<string, string>;
  perCall: number | undefined;
  clientDefault: number | undefined;
  timeoutMs: number;
}): TimeoutPlan {
  const { method, url, headers, perCall, clientDefault, timeoutMs } = args;
  const operationDefault = operationDefaultTimeout(method, url.pathname);

  let send: number | undefined;
  let serverSeconds: number | undefined;
  if (perCall !== undefined) {
    send = validateRequestTimeout(perCall);
    serverSeconds = send;
  } else {
    const manualHeader = Object.entries(headers).find(([k]) => k.toLowerCase() === REQUEST_TIMEOUT_HEADER.toLowerCase());
    const manual = manualHeader
      ? parseSeconds(manualHeader[1])
      : parseSeconds(url.searchParams.get(REQUEST_TIMEOUT_QUERY));
    if (manualHeader || url.searchParams.has(REQUEST_TIMEOUT_QUERY)) {
      serverSeconds = manual;
    } else if (clientDefault !== undefined && operationDefault !== undefined) {
      send = clientDefault;
      serverSeconds = clientDefault;
    }
  }
  serverSeconds ??= operationDefault;

  const deadlineMs = serverSeconds === undefined
    ? timeoutMs
    : Math.max(timeoutMs, Math.ceil(serverSeconds * 1000) + SERVER_ANSWER_MARGIN_MS);
  return { send, deadlineMs };
}

/** Replaces any case variant of X-Request-Timeout in `headers` with `seconds`. */
export function setTimeoutHeader(headers: Record<string, string>, seconds: number): void {
  for (const key of Object.keys(headers)) {
    if (key.toLowerCase() === REQUEST_TIMEOUT_HEADER.toLowerCase()) delete headers[key];
  }
  headers[REQUEST_TIMEOUT_HEADER] = String(seconds);
}
