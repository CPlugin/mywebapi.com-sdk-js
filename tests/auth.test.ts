import { describe, expect, test, beforeEach } from 'bun:test';
import {
  ClientCredentialsTokenProvider,
  OAuth2TokenError,
  StaticTokenProvider,
} from '../src/auth';

const OIDC_FIXTURE_PATH = '/code/web/webapi/clients/_shared/fixtures/openid-configuration.json';

async function loadDiscoveryDoc(): Promise<unknown> {
  return await Bun.file(OIDC_FIXTURE_PATH).json();
}

// Fetch mock: routes requests by URL to scripted responses. Each handler may
// return a Response or throw. Calls are recorded for assertion.
interface MockCall {
  url: string;
  init: RequestInit | undefined;
}

function makeFetchMock(handlers: {
  discovery?: () => Response | Promise<Response>;
  token?: ((call: MockCall) => Response | Promise<Response>);
}): { fetch: typeof fetch; calls: MockCall[] } {
  const calls: MockCall[] = [];
  const fn = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
    calls.push({ url, init });
    if (url.includes('/.well-known/openid-configuration')) {
      if (!handlers.discovery) throw new Error('unexpected discovery call');
      return await handlers.discovery();
    }
    if (url.endsWith('/connect/token')) {
      if (!handlers.token) throw new Error('unexpected token call');
      return await handlers.token({ url, init });
    }
    throw new Error(`unexpected fetch URL: ${url}`);
  }) as unknown as typeof fetch;
  return { fetch: fn, calls };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

let discoveryDoc: unknown;

beforeEach(async () => {
  discoveryDoc = await loadDiscoveryDoc();
});

describe('StaticTokenProvider', () => {
  test('returns the supplied token unconditionally with no fetches', async () => {
    const provider = new StaticTokenProvider('eyJ.fake.token');
    expect(await provider.getToken()).toBe('eyJ.fake.token');
    expect(await provider.getToken({ forceRefresh: true })).toBe('eyJ.fake.token');
  });
});

describe('ClientCredentialsTokenProvider', () => {
  test('first getToken() performs discovery then token request', async () => {
    const mock = makeFetchMock({
      discovery: () => jsonResponse(discoveryDoc),
      token: () => jsonResponse({ access_token: 'tok-1', expires_in: 3600 }),
    });
    const provider = new ClientCredentialsTokenProvider({
      clientId: 'cid',
      clientSecret: 'csec',
      identityUrl: 'https://identity.example',
      fetch: mock.fetch,
    });
    const tok = await provider.getToken();
    expect(tok).toBe('tok-1');
    expect(mock.calls.length).toBe(2);
    expect(mock.calls[0]!.url).toContain('/.well-known/openid-configuration');
    expect(mock.calls[1]!.url).toBe('https://identity.example/connect/token');
  });

  test('second getToken() within TTL is a cache hit (zero additional fetches)', async () => {
    const mock = makeFetchMock({
      discovery: () => jsonResponse(discoveryDoc),
      token: () => jsonResponse({ access_token: 'tok-cache', expires_in: 3600 }),
    });
    const provider = new ClientCredentialsTokenProvider({
      clientId: 'cid',
      clientSecret: 'csec',
      identityUrl: 'https://identity.example',
      fetch: mock.fetch,
    });
    await provider.getToken();
    const callsAfterFirst = mock.calls.length;
    const tok2 = await provider.getToken();
    expect(tok2).toBe('tok-cache');
    expect(mock.calls.length).toBe(callsAfterFirst);
  });

  test('expired token triggers exactly one new token call, no re-discovery', async () => {
    // clockSkewSeconds large enough (>= expires_in) → cached token is treated as
    // already expired immediately, forcing a refresh on the next getToken().
    let tokenCalls = 0;
    let discoveryCalls = 0;
    const mock = makeFetchMock({
      discovery: () => {
        discoveryCalls++;
        return jsonResponse(discoveryDoc);
      },
      token: () => {
        tokenCalls++;
        return jsonResponse({ access_token: `tok-${tokenCalls}`, expires_in: 60 });
      },
    });
    const provider = new ClientCredentialsTokenProvider({
      clientId: 'cid',
      clientSecret: 'csec',
      identityUrl: 'https://identity.example',
      fetch: mock.fetch,
      clockSkewSeconds: 3600,
    });
    expect(await provider.getToken()).toBe('tok-1');
    expect(await provider.getToken()).toBe('tok-2');
    expect(tokenCalls).toBe(2);
    expect(discoveryCalls).toBe(1);
  });

  test('100 concurrent getToken() calls coalesce to a single token request', async () => {
    let tokenCalls = 0;
    const mock = makeFetchMock({
      discovery: () => jsonResponse(discoveryDoc),
      token: async () => {
        tokenCalls++;
        // Tiny delay so concurrent callers definitely see refreshPromise set.
        await new Promise((r) => setTimeout(r, 5));
        return jsonResponse({ access_token: 'tok-single', expires_in: 3600 });
      },
    });
    const provider = new ClientCredentialsTokenProvider({
      clientId: 'cid',
      clientSecret: 'csec',
      identityUrl: 'https://identity.example',
      fetch: mock.fetch,
    });

    // Critical: build the array synchronously — no `await` between dispatches.
    const promises = [...Array(100)].map(() => provider.getToken());
    const results = await Promise.all(promises);

    expect(results.every((t) => t === 'tok-single')).toBe(true);
    expect(tokenCalls).toBe(1);
  });

  test('forceRefresh: true bypasses cache even within TTL', async () => {
    let tokenCalls = 0;
    const mock = makeFetchMock({
      discovery: () => jsonResponse(discoveryDoc),
      token: () => {
        tokenCalls++;
        return jsonResponse({ access_token: `tok-${tokenCalls}`, expires_in: 3600 });
      },
    });
    const provider = new ClientCredentialsTokenProvider({
      clientId: 'cid',
      clientSecret: 'csec',
      identityUrl: 'https://identity.example',
      fetch: mock.fetch,
    });
    expect(await provider.getToken()).toBe('tok-1');
    expect(await provider.getToken({ forceRefresh: true })).toBe('tok-2');
    expect(tokenCalls).toBe(2);
  });

  test('400 invalid_client surfaces as OAuth2TokenError with parsed fields', async () => {
    const mock = makeFetchMock({
      discovery: () => jsonResponse(discoveryDoc),
      token: () =>
        jsonResponse(
          { error: 'invalid_client', error_description: 'Client authentication failed.' },
          400,
        ),
    });
    const provider = new ClientCredentialsTokenProvider({
      clientId: 'cid',
      clientSecret: 'csec',
      identityUrl: 'https://identity.example',
      fetch: mock.fetch,
    });
    let caught: unknown = null;
    try {
      await provider.getToken();
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(OAuth2TokenError);
    const err = caught as OAuth2TokenError;
    expect(err.status).toBe(400);
    expect(err.errorCode).toBe('invalid_client');
    expect(err.errorDescription).toBe('Client authentication failed.');
    expect(err.message).toContain('invalid_client');
  });

  test('500 with non-JSON body produces OAuth2TokenError with status set and no errorCode', async () => {
    const mock = makeFetchMock({
      discovery: () => jsonResponse(discoveryDoc),
      token: () =>
        new Response('Internal Server Error', {
          status: 500,
          headers: { 'Content-Type': 'text/plain' },
        }),
    });
    const provider = new ClientCredentialsTokenProvider({
      clientId: 'cid',
      clientSecret: 'csec',
      identityUrl: 'https://identity.example',
      fetch: mock.fetch,
    });
    let caught: unknown = null;
    try {
      await provider.getToken();
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(OAuth2TokenError);
    const err = caught as OAuth2TokenError;
    expect(err.status).toBe(500);
    expect(err.errorCode).toBeUndefined();
  });

  test('discovery 404 throws; next call retries discovery (promise reset)', async () => {
    let discoveryCalls = 0;
    let discoveryShouldFail = true;
    const mock = makeFetchMock({
      discovery: () => {
        discoveryCalls++;
        if (discoveryShouldFail) {
          return new Response('not found', { status: 404 });
        }
        return jsonResponse(discoveryDoc);
      },
      token: () => jsonResponse({ access_token: 'tok-after-retry', expires_in: 3600 }),
    });
    const provider = new ClientCredentialsTokenProvider({
      clientId: 'cid',
      clientSecret: 'csec',
      identityUrl: 'https://identity.example',
      fetch: mock.fetch,
    });

    let firstErr: unknown = null;
    try {
      await provider.getToken();
    } catch (e) {
      firstErr = e;
    }
    expect(firstErr).toBeInstanceOf(OAuth2TokenError);
    expect(discoveryCalls).toBe(1);

    discoveryShouldFail = false;
    const tok = await provider.getToken();
    expect(tok).toBe('tok-after-retry');
    expect(discoveryCalls).toBe(2);
  });

  test('scopes joined with space and included in token POST body', async () => {
    let capturedBody = '';
    const mock = makeFetchMock({
      discovery: () => jsonResponse(discoveryDoc),
      token: ({ init }) => {
        capturedBody = typeof init?.body === 'string' ? init.body : '';
        return jsonResponse({ access_token: 'tok-scoped', expires_in: 3600 });
      },
    });
    const provider = new ClientCredentialsTokenProvider({
      clientId: 'cid',
      clientSecret: 'csec',
      identityUrl: 'https://identity.example',
      scopes: ['webapi.read', 'webapi.write'],
      fetch: mock.fetch,
    });
    await provider.getToken();
    const parsed = new URLSearchParams(capturedBody);
    expect(parsed.get('grant_type')).toBe('client_credentials');
    expect(parsed.get('client_id')).toBe('cid');
    expect(parsed.get('client_secret')).toBe('csec');
    expect(parsed.get('scope')).toBe('webapi.read webapi.write');
  });
});
