import { describe, expect, test } from 'bun:test';
import { CPluginWebApiClient } from '../src/client';
import { MT4V2SignalRClient } from '../src/signalr';
import { MT5V2SignalRClient } from '../src/signalr.mt5';

const json = (b: unknown, status = 200) =>
  new Response(JSON.stringify(b), { status, headers: { 'Content-Type': 'application/json' } });

// * A mock fetch that satisfies OIDC discovery + token endpoint so the shared
// *   provider can mint a token without touching the network.
function authMockFetch(): typeof fetch {
  return ((url: string) => {
    if (url.endsWith('/.well-known/openid-configuration'))
      return json({ token_endpoint: 'https://pre.auth.cplugin.net/connect/token' });
    if (url.endsWith('/connect/token')) return json({ access_token: 'tok-shared', expires_in: 3600 });
    return json({ data: null, error: null, meta: null });
  }) as unknown as typeof fetch;
}

describe('CPluginWebApiClient.realtime', () => {
  test('mt4() returns an MT4V2SignalRClient bound to the shared provider and base URL', async () => {
    const client = new CPluginWebApiClient({
      env: 'staging',
      clientId: 'cid',
      clientSecret: 'csec',
      fetch: authMockFetch(),
    });
    const tp = '3029d415-d0a6-4710-a9c1-8cb063ef872f';
    const rt = client.realtime.mt4(tp);
    expect(rt).toBeInstanceOf(MT4V2SignalRClient);
    // * Hub URL is derived from the SDK's apiBaseUrl + tradePlatform parameter.
    expect(rt.hubUrlForTest).toBe(`https://pre.mywebapi.com/hubs/mt4/v2?tradePlatform=${tp}`);
    // * The accessor shares the SDK's token provider — the same cached token is minted.
    expect(await rt.tokenForTest()).toBe('tok-shared');
  });

  test('mt4() requires a non-empty tradePlatform', () => {
    const client = new CPluginWebApiClient({ env: 'prod', clientId: 'c', clientSecret: 's' });
    expect(() => client.realtime.mt4('')).toThrow();
  });

  test('mt5() returns an MT5V2SignalRClient on the /hubs/mt5/v2 route', () => {
    const client = new CPluginWebApiClient({ env: 'staging', clientId: 'c', clientSecret: 's', fetch: authMockFetch() });
    const tp = '57e1d286-2780-41a3-9bb2-aa69191cad56';
    const rt = client.realtime.mt5(tp);
    expect(rt).toBeInstanceOf(MT5V2SignalRClient);
    // * Hub URL is derived from the SDK's apiBaseUrl + tradePlatform parameter.
    expect(rt.hubUrlForTest).toBe(`https://pre.mywebapi.com/hubs/mt5/v2?tradePlatform=${tp}`);
  });

  test('mt5() requires a non-empty tradePlatform', () => {
    const client = new CPluginWebApiClient({ env: 'prod', clientId: 'c', clientSecret: 's' });
    expect(() => client.realtime.mt5('')).toThrow();
  });
});
