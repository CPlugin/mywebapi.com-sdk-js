// * Shared harness for all E2E tests.
//
// Reads connection parameters from environment variables and exposes
// three helpers used by every E2E test file:
//   - E2E_ENABLED     — gate flag; false → all E2E suites skip cleanly
//   - makeClient()    — builds a CPluginWebApiClient from env vars
//   - resolveTp()     — resolves the trade platform ID (env override or auto-pick)
//   - withTimeout()   — wraps a Promise with a deadline and a clear failure label
//
// Required env vars (must ALL be set for E2E_ENABLED to be true):
//   WEBAPI_BASE_URL        — e.g. https://cloud.mywebapi.com
//   WEBAPI_AUTH_SERVER     — e.g. https://auth.cplugin.net
//   WEBAPI_CLIENT_ID       — OAuth2 client_id (manager credential)
//   WEBAPI_CLIENT_SECRET   — OAuth2 client_secret
//
// Optional env vars:
//   WEBAPI_TRADE_PLATFORM       — platform ID override; auto-selected when omitted and only one exists
//   WEBAPI_SYMBOL               — symbol for tick streaming (default: EURUSD)
//   WEBAPI_E2E_TICK_TIMEOUT_MS  — ms to wait for the first tick (default: 20000)

import { CPluginWebApiClient } from '../src/index';
import type { TradePlatform } from '../src/index';

// ---------------------------------------------------------------------------
// * Read configuration from environment
// ---------------------------------------------------------------------------

const _baseUrl       = process.env['WEBAPI_BASE_URL'];
const _authServer    = process.env['WEBAPI_AUTH_SERVER'];
const _clientId      = process.env['WEBAPI_CLIENT_ID'];
const _clientSecret  = process.env['WEBAPI_CLIENT_SECRET'];

const _allRequired = Boolean(_baseUrl && _authServer && _clientId && _clientSecret);

// * E2E suite is active only when the explicit opt-in flag is set AND all four
//   required credentials are present.  Without this both conditions, every
//   E2E describe block is skipped so `bun test` stays green on CI/offline.
export const E2E_ENABLED: boolean =
  process.env['WEBAPI_E2E'] === '1' && _allRequired;

export const SYMBOL: string =
  process.env['WEBAPI_SYMBOL'] ?? 'EURUSD';

export const TICK_TIMEOUT_MS: number =
  Number(process.env['WEBAPI_E2E_TICK_TIMEOUT_MS'] ?? '20000');

// ---------------------------------------------------------------------------
// * Client factory
// ---------------------------------------------------------------------------

/**
 * Build a `CPluginWebApiClient` from the E2E environment variables.
 *
 * ! Only call this inside a suite guarded by `E2E_ENABLED` — the function
 *   will throw if any required var is missing.
 */
export function makeClient(): CPluginWebApiClient {
  if (!_allRequired) {
    throw new Error(
      'makeClient() called but required E2E env vars are missing. ' +
      'Set WEBAPI_BASE_URL, WEBAPI_AUTH_SERVER, WEBAPI_CLIENT_ID, WEBAPI_CLIENT_SECRET.',
    );
  }
  return new CPluginWebApiClient({
    env:          'custom',
    apiBaseUrl:   _baseUrl!,
    authority:    _authServer!,
    clientId:     _clientId!,
    clientSecret: _clientSecret!,
  });
}

// ---------------------------------------------------------------------------
// * Trade-platform resolver
// ---------------------------------------------------------------------------

/**
 * Resolve the trade platform ID to use for this E2E run.
 *
 * Resolution order:
 * 1. `WEBAPI_TRADE_PLATFORM` env var — explicit override, skips discovery.
 * 2. Discovery via `listTradePlatforms()`:
 *    - Exactly one platform → auto-selected.
 *    - Zero platforms → throws (credential has no accessible platforms).
 *    - Two or more → throws with the list of IDs (set `WEBAPI_TRADE_PLATFORM`).
 */
export async function resolveTp(client: CPluginWebApiClient): Promise<string> {
  const explicit = process.env['WEBAPI_TRADE_PLATFORM'];
  if (explicit) return explicit;

  let platforms: TradePlatform[];
  try {
    platforms = await client.listTradePlatforms();
  } catch (err) {
    throw new Error(`E2E: listTradePlatforms() failed — ${String(err)}`);
  }

  if (platforms.length === 0) {
    throw new Error(
      'E2E: no trade platforms returned for this credential. ' +
      'Grant the client access to at least one platform in the Toolbox.',
    );
  }

  if (platforms.length === 1) {
    const id = platforms[0]!.id;
    console.log(`[E2E] Auto-selected trade platform: ${id}`);
    return id;
  }

  // * Multiple platforms — require explicit selection to avoid acting on the
  //   wrong one (e.g. a live production platform instead of a test instance).
  const ids = platforms.map((p) => p.id).join(', ');
  throw new Error(
    `E2E: multiple trade platforms found [${ids}]. ` +
    'Set WEBAPI_TRADE_PLATFORM to one of these IDs.',
  );
}

// ---------------------------------------------------------------------------
// * Timeout helper
// ---------------------------------------------------------------------------

/**
 * Race `promise` against a deadline.  Rejects with a descriptive error when
 * the deadline expires before `promise` resolves.
 *
 * @param promise  - The operation to time out.
 * @param ms       - Deadline in milliseconds.
 * @param label    - Human-readable operation name used in the error message.
 */
export function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(
        `E2E timeout (${ms} ms): "${label}" did not complete in time. ` +
        'Ensure the server is reachable and the trade platform is connected.',
      ));
    }, ms);

    promise.then(
      (value) => { clearTimeout(timer); resolve(value); },
      (err)   => { clearTimeout(timer); reject(err); },
    );
  });
}
