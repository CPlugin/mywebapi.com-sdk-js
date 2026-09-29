import type { CPluginWebApiClient, CPluginWebApiClientInit } from '@mywebapi.com/sdk';
import { ApiError, isOutcomeUnknown, isRetryable, MT4V2SignalRClient, StaticTokenProvider } from '@mywebapi.com/sdk';
import type { RequestOutcome } from '@mywebapi.com/sdk';

const init: CPluginWebApiClientInit = {
  env: 'custom',
  apiBaseUrl: 'https://api.example.test',
  authority: 'https://identity.example.test',
  clientId: 'fixture-client',
  clientSecret: 'fixture-secret',
  timeoutMs: 5_000,
  requestTimeout: 20,
};
const client = null as unknown as CPluginWebApiClient;
const time: Promise<string> = client.mt4.getServerTime('fixture-platform');
const timed: Promise<string> = client.mt4.getServerTime('fixture-platform', { requestTimeout: 2.5 });
const trade = client.mt4.postTradeTransaction('fixture-platform', { symbol: 'EURUSD' }, {
  requestTimeout: 10,
  headers: { 'Idempotency-Key': 'fixture-key' },
});
// @ts-expect-error requestTimeout is a number of seconds
void client.mt4.getServerTime('fixture-platform', { requestTimeout: '10' });
const outcome: RequestOutcome | undefined = new ApiError({ code: 'Busy' }, null, 200).outcome;
const flags: boolean[] = [isOutcomeUnknown(null), isRetryable(null)];
const realtime = new MT4V2SignalRClient({
  baseUrl: 'https://api.example.test',
  tradePlatform: 'fixture-platform',
  tokenProvider: new StaticTokenProvider('fixture-token'),
});
void init;
void time;
void timed;
void trade;
void outcome;
void flags;
void realtime;