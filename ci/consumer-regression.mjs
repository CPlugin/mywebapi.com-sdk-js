import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const consumerRoot = process.env.SDK_CONSUMER_ROOT ?? process.cwd();
const require = createRequire(pathToFileURL(resolve(consumerRoot, 'package.json')));
const sdk = await import(require.resolve('@mywebapi.com/sdk'));
const checks = [];
const calls = [];
const counters = new Map();

function responseJson(value, init = {}) {
  return new Response(JSON.stringify(value), {
    ...init,
    headers: { 'content-type': 'application/json', ...(init.headers ?? {}) },
  });
}
function count(path) {
  const next = (counters.get(path) ?? 0) + 1;
  counters.set(path, next);
  return next;
}

const fetchMock = async (input, init = {}) => {
  const url = String(input);
  const method = (init.method ?? 'GET').toUpperCase();
  calls.push({ method, url, redirect: init.redirect, headers: init.headers });
  if (url.endsWith('/.well-known/openid-configuration')) {
    return responseJson({ token_endpoint: 'https://identity.example.test/connect/token' });
  }
  if (url.endsWith('/connect/token')) {
    return responseJson({ access_token: 'fixture-token', expires_in: 3600 });
  }
  if (url.includes('/api/TradePlatforms')) {
    if (count('platforms') === 1) return responseJson({ error: 'temporary' }, { status: 503 });
    return responseJson([{ id: 'tp-1', name: 'Fixture' }]);
  }
  if (method === 'POST') return new Response('temporary', { status: 503 });
  if (url.includes('/ServerTime')) {
    return responseJson({
      data: '2026-09-17T00:00:00Z',
      error: null,
      meta: { activityId: 'fixture' },
    });
  }
  return responseJson({ data: null, error: { code: 'NotFound', message: 'fixture route' }, meta: null }, { status: 404 });
};

const client = new sdk.CPluginWebApiClient({
  env: 'custom',
  apiBaseUrl: 'https://api.example.test',
  authority: 'https://identity.example.test',
  clientId: 'fixture-client',
  clientSecret: 'fixture-secret',
  fetch: fetchMock,
  retry: { baseDelayMs: 0, maxDelayMs: 0, jitterPercent: 0 },
});

const serverTime = await client.mt4.getServerTime('tp/with slash');
if (serverTime !== '2026-09-17T00:00:00Z') throw new Error('server-time envelope was not unwrapped');
const encoded = calls.find((call) => call.url.includes('/ServerTime'));
if (!encoded?.url.includes('tp%2Fwith%20slash')) throw new Error('path parameter was not encoded');
if (encoded.redirect !== 'error') throw new Error('API redirect policy was not fail-closed');
checks.push('node import, v2 envelope, encoded path, redirect:error');

const platforms = await client.listTradePlatforms();
if (platforms.length !== 1 || counters.get('platforms') !== 2) throw new Error('safe GET retry did not complete exactly once');
checks.push('safe GET retry');

let postError;
try { await client.mt4.postSrvRestart('tp/with slash', undefined, { headers: { 'Idempotency-Key': 'fixture-key' } }); }
catch (error) { postError = error; }
if (!(postError instanceof sdk.ApiError && calls.filter((call) => call.method === 'POST' && call.url.includes('/api/')).length === 1 && calls.find((call) => call.method === 'POST' && call.url.includes('/api/'))?.headers?.['Idempotency-Key'] === 'fixture-key')) {
  throw new Error('unsafe POST was replayed or did not surface ApiError');
}
checks.push('unsafe POST no replay');
console.log(JSON.stringify({ checks, packageEntry: require.resolve('@mywebapi.com/sdk') }));