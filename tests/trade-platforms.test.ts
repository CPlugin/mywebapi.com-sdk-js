// listTradePlatforms() — unit tests.
//
// Contracts verified:
//   1. Returns the parsed array from a plain JSON array response (no v2 envelope).
//   2. Sets Authorization: Bearer <token> header on the request.
//   3. Sends to the unversioned /api/TradePlatforms path (NOT /api/v2/…).
//   4. 401 → force-refresh once → retry → succeeds on second attempt.
//   5. Non-2xx (e.g. 403) → throws ApiError with the correct code.

import { describe, expect, test } from 'bun:test';
import { CPluginWebApiClient } from '../src/client';
import { ApiError } from '../src/errors';

// ---------------------------------------------------------------------------
// Helpers — reuse the pattern established in client.test.ts
// ---------------------------------------------------------------------------

const json = (b: unknown, status = 200): Response =>
  new Response(JSON.stringify(b), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });

const PLATFORMS = [{ id: 'guid-1', name: 'Demo MT4', type: 'MT4', login: 1 }];

/** Full mock: routes OIDC discovery → token → arbitrary handler for everything else. */
function makeFullMock(handler: (url: string, init?: RequestInit) => Response): typeof fetch {
  let tokenSeq = 0;
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url =
      typeof input === 'string'
        ? input
        : input instanceof URL
          ? input.toString()
          : (input as Request).url;

    if (url.includes('/.well-known/openid-configuration')) {
      return json({
        token_endpoint: 'https://auth.example/connect/token',
        issuer: 'https://auth.example',
      });
    }
    if (url.endsWith('/connect/token')) {
      tokenSeq++;
      return json({ access_token: `tok-${tokenSeq}`, expires_in: 3600 });
    }
    return handler(url, init);
  }) as unknown as typeof fetch;
}

// ---------------------------------------------------------------------------
// Test 1: happy path — parses plain JSON array (no v2 envelope)
// ---------------------------------------------------------------------------
describe('CPluginWebApiClient.listTradePlatforms — happy path', () => {
  test('returns the parsed platform array from a plain JSON array response', async () => {
    // * The server returns a flat array — NOT the {data,error,meta} v2 envelope.
    const client = new CPluginWebApiClient({
      env: 'staging',
      clientId: 'cid',
      clientSecret: 'csec',
      fetch: makeFullMock(() => json(PLATFORMS)),
    });

    const result = await client.listTradePlatforms();
    const [first] = result;

    expect(result).toHaveLength(1);
    expect(first?.id).toBe('guid-1');
    expect(first?.name).toBe('Demo MT4');
    expect(first?.type).toBe('MT4');
    expect(first?.login).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Test 2: Authorization header + unversioned URL
// ---------------------------------------------------------------------------
describe('CPluginWebApiClient.listTradePlatforms — request shape', () => {
  test('sends Authorization: Bearer header to /api/TradePlatforms (not /api/v2/)', async () => {
    let capturedUrl = '';
    let capturedAuth = '';

    const client = new CPluginWebApiClient({
      env: 'staging',
      clientId: 'cid',
      clientSecret: 'csec',
      fetch: makeFullMock((url, init) => {
        if (url.includes('/api/TradePlatforms')) {
          capturedUrl = url;
          capturedAuth = (init?.headers as Record<string, string>)?.['Authorization'] ?? '';
        }
        return json(PLATFORMS);
      }),
    });

    await client.listTradePlatforms();

    // * Must hit the unversioned endpoint — /api/v2/ would be wrong.
    expect(capturedUrl).toContain('/api/TradePlatforms');
    expect(capturedUrl).not.toContain('/api/v2/');
    // * Must carry a Bearer token minted by the token provider.
    expect(capturedAuth).toMatch(/^Bearer tok-\d+$/);
  });
});

// ---------------------------------------------------------------------------
// Test 3: 401 → force-refresh → retry succeeds
// ---------------------------------------------------------------------------
describe('CPluginWebApiClient.listTradePlatforms — 401 retry', () => {
  test('retries once with a refreshed token on HTTP 401', async () => {
    let callCount = 0;
    let tokenSeq = 0;

    const fetchMock = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url =
        typeof input === 'string'
          ? input
          : input instanceof URL
            ? input.toString()
            : (input as Request).url;

      if (url.includes('/.well-known/openid-configuration')) {
        return json({
          token_endpoint: 'https://auth.example/connect/token',
          issuer: 'https://auth.example',
        });
      }
      if (url.endsWith('/connect/token')) {
        tokenSeq++;
        return json({ access_token: `tok-${tokenSeq}`, expires_in: 3600 });
      }

      // * First call to the platforms endpoint returns 401; second returns 200.
      callCount++;
      if (callCount === 1) return json({}, 401);
      return json(PLATFORMS);
    }) as unknown as typeof fetch;

    const client = new CPluginWebApiClient({
      env: 'staging',
      clientId: 'cid',
      clientSecret: 'csec',
      fetch: fetchMock,
    });

    const result = await client.listTradePlatforms();
    const [first] = result;

    // * The retry succeeded — the result is the platform list.
    expect(result).toHaveLength(1);
    expect(first?.id).toBe('guid-1');
    // * Exactly two calls to the platforms endpoint (original + retry).
    expect(callCount).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// Test 4: non-2xx after retry → ApiError with correct code
// ---------------------------------------------------------------------------
describe('CPluginWebApiClient.listTradePlatforms — error mapping', () => {
  test('throws ApiError(Forbidden) on HTTP 403', async () => {
    const client = new CPluginWebApiClient({
      env: 'staging',
      clientId: 'cid',
      clientSecret: 'csec',
      fetch: makeFullMock(() => json({ message: 'denied' }, 403)),
    });

    let caught: unknown = null;
    try {
      await client.listTradePlatforms();
    } catch (e) {
      caught = e;
    }

    expect(caught).toBeInstanceOf(ApiError);
    const err = caught as ApiError;
    expect(err.code).toBe('Forbidden');
    expect(err.status).toBe(403);
  });

  test('throws ApiError(NotFound) on HTTP 404', async () => {
    const client = new CPluginWebApiClient({
      env: 'staging',
      clientId: 'cid',
      clientSecret: 'csec',
      fetch: makeFullMock(() => json({}, 404)),
    });

    let caught: unknown = null;
    try {
      await client.listTradePlatforms();
    } catch (e) {
      caught = e;
    }

    expect(caught).toBeInstanceOf(ApiError);
    const err = caught as ApiError;
    expect(err.code).toBe('NotFound');
    expect(err.status).toBe(404);
  });

  test('throws ApiError(Internal) on HTTP 500', async () => {
    const client = new CPluginWebApiClient({
      env: 'staging',
      clientId: 'cid',
      clientSecret: 'csec',
      fetch: makeFullMock(() => json({}, 500)),
    });

    let caught: unknown = null;
    try {
      await client.listTradePlatforms();
    } catch (e) {
      caught = e;
    }

    expect(caught).toBeInstanceOf(ApiError);
    const err = caught as ApiError;
    expect(err.code).toBe('Internal');
    expect(err.status).toBe(500);
  });
});
