// One representative call per v2 group added in 0.5.0 (MT4 dealer; MT5
// subscriptions, configuration and config-trade, reports, market insight,
// communications, clients, trading, trade operations, market data, users
// extras). Each test checks that a typed envelope payload survives the
// transport and that the caller sees the unwrapped, typed value.

import { describe, expect, test } from 'bun:test';
import { CPluginWebApiClient } from '../src/client';

const TP = 'tp-1';

const json = (b: unknown, status = 200): Response =>
  new Response(JSON.stringify(b), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });

const envelope = <T>(data: T) => ({ data, error: null, meta: { activityId: 'a1' } });

// * Discovery + token + one API answer, recording the request path.
function mock(data: unknown, seen: { url?: string; method?: string }): typeof fetch {
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url =
      typeof input === 'string' ? input : input instanceof URL ? input.toString() : (input as Request).url;
    if (url.includes('/.well-known/openid-configuration')) {
      return json({ token_endpoint: 'https://pre.auth.cplugin.net/connect/token', issuer: 'https://pre.auth.cplugin.net' });
    }
    if (url.endsWith('/connect/token')) return json({ access_token: 'tok-1', expires_in: 3600 });
    seen.url = url;
    seen.method = (init?.method ?? 'GET').toUpperCase();
    return json(envelope(data));
  }) as unknown as typeof fetch;
}

function clientFor(data: unknown, seen: { url?: string; method?: string }): CPluginWebApiClient {
  return new CPluginWebApiClient({
    env: 'staging',
    clientId: 'cid',
    clientSecret: 'csec',
    fetch: mock(data, seen),
  });
}

describe('v2 groups added in 0.5.0 — typed payloads round-trip', () => {
  test('MT4 dealer: getSummaryGetAll', async () => {
    const seen: { url?: string; method?: string } = {};
    const client = clientFor([{ symbol: 'EURUSD', buyLots: 1.5, sellLots: 0.5 }], seen);
    const result = await client.mt4.getSummaryGetAll(TP);
    expect(seen.url).toContain(`/api/v2/MT4/${TP}/SummaryGetAll`);
    expect(result[0]?.symbol).toBe('EURUSD');
    expect(result[0]?.buyLots).toBe(1.5);
  });

  test('MT5 subscriptions: getSubscriptionCfgRequestName', async () => {
    const seen: { url?: string; method?: string } = {};
    const client = clientFor({ id: 7, description: 'news', countries: ['DE'] }, seen);
    const result = await client.mt5.getSubscriptionCfgRequestName(TP, 'news');
    expect(seen.url).toContain(`/api/v2/MT5/${TP}/SubscriptionCfgRequest/news`);
    expect(result.id).toBe(7);
    expect(result.countries?.[0]).toBe('DE');
  });

  test('MT5 configuration: getLeverageRequestName', async () => {
    const seen: { url?: string; method?: string } = {};
    const client = clientFor({ name: 'pro', rules: [{ name: 'r1', path: 'Forex' }] }, seen);
    const result = await client.mt5.getLeverageRequestName(TP, 'pro');
    expect(seen.url).toContain(`/api/v2/MT5/${TP}/LeverageRequest/pro`);
    expect(result.name).toBe('pro');
    expect(result.rules?.[0]?.path).toBe('Forex');
  });

  test('MT5 config-trade: postGroupUpdateGroup', async () => {
    const seen: { url?: string; method?: string } = {};
    const client = clientFor({ group: 'demo\\pro', marginCall: 50 }, seen);
    const result = await client.mt5.postGroupUpdateGroup(TP, 'demo\\pro', { marginCall: 50 });
    expect(seen.url).toContain(`/api/v2/MT5/${TP}/GroupUpdate/demo%5Cpro`);
    expect(seen.method).toBe('POST');
    expect(result.group).toBe('demo\\pro');
    expect(result.marginCall).toBe(50);
  });

  test('MT5 reports: getDailyRequestLogin', async () => {
    const seen: { url?: string; method?: string } = {};
    const client = clientFor([{ login: 1001, balance: 5000, dailyProfit: 12.5 }], seen);
    const result = await client.mt5.getDailyRequestLogin(TP, 1001);
    expect(seen.url).toContain(`/api/v2/MT5/${TP}/DailyRequest/1001`);
    expect(result[0]?.login).toBe(1001);
    expect(result[0]?.dailyProfit).toBe(12.5);
  });

  test('MT5 market insight: getBookGetSymbol', async () => {
    const seen: { url?: string; method?: string } = {};
    const client = clientFor({ symbol: 'EURUSD', items: [{ type: 2, price: 1.0855, volume: 3 }] }, seen);
    const result = await client.mt5.getBookGetSymbol(TP, 'EURUSD');
    expect(seen.url).toContain(`/api/v2/MT5/${TP}/BookGet/EURUSD`);
    expect(result.symbol).toBe('EURUSD');
    expect(result.items?.[0]?.price).toBe(1.0855);
  });

  test('MT5 communications: getLoggerServerRequest', async () => {
    const seen: { url?: string; method?: string } = {};
    const client = clientFor([{ code: 1, message: 'ready', source: 'server' }], seen);
    const result = await client.mt5.getLoggerServerRequest(TP);
    expect(seen.url).toContain(`/api/v2/MT5/${TP}/LoggerServerRequest`);
    expect(result[0]?.message).toBe('ready');
    expect(result[0]?.source).toBe('server');
  });

  test('MT5 clients: getAttachmentRequest', async () => {
    const seen: { url?: string; method?: string } = {};
    const client = clientFor([{ documentID: 11, fileName: 'passport.pdf' }], seen);
    const result = await client.mt5.getAttachmentRequest(TP);
    expect(seen.url).toContain(`/api/v2/MT5/${TP}/AttachmentRequest`);
    expect(result[0]?.fileName).toBe('passport.pdf');
  });

  test('MT5 trading: getDealRequestByLoginsSymbolSymbol', async () => {
    const seen: { url?: string; method?: string } = {};
    const client = clientFor([{ deal: 9001, symbol: 'EURUSD', volume: 1 }], seen);
    const result = await client.mt5.getDealRequestByLoginsSymbolSymbol(TP, 'EURUSD');
    expect(seen.url).toContain(`/api/v2/MT5/${TP}/DealRequestByLoginsSymbol/EURUSD`);
    expect(result[0]?.deal).toBe(9001);
    expect(result[0]?.volume).toBe(1);
  });

  test('MT5 trade operations: getRequestGetAll', async () => {
    const seen: { url?: string; method?: string } = {};
    const client = clientFor([{ id: 42, login: 1001, symbol: 'EURUSD', action: 200 }], seen);
    const result = await client.mt5.getRequestGetAll(TP);
    expect(seen.url).toContain(`/api/v2/MT5/${TP}/RequestGetAll`);
    expect(result[0]?.id).toBe(42);
    expect(result[0]?.login).toBe(1001);
  });

  test('MT5 market data: getTickLastSymbol', async () => {
    const seen: { url?: string; method?: string } = {};
    const client = clientFor({ symbol: 'EURUSD', bid: 1.0854, ask: 1.0856, time: 1763900000 }, seen);
    const result = await client.mt5.getTickLastSymbol(TP, 'EURUSD');
    expect(seen.url).toContain(`/api/v2/MT5/${TP}/TickLast/EURUSD`);
    expect(result.bid).toBe(1.0854);
    expect(result.ask).toBe(1.0856);
  });

  test('MT5 users extras: getUserCertGetLogin', async () => {
    const seen: { url?: string; method?: string } = {};
    const client = clientFor({ nameCommon: 'Client 1001', isOpened: true }, seen);
    const result = await client.mt5.getUserCertGetLogin(TP, 1001);
    expect(seen.url).toContain(`/api/v2/MT5/${TP}/UserCertGet/1001`);
    expect(result.nameCommon).toBe('Client 1001');
    expect(result.isOpened).toBe(true);
  });
});
