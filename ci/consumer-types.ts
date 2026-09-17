import type { CPluginWebApiClient, CPluginWebApiClientInit } from '@mywebapi.com/sdk';
import { MT4V2SignalRClient, StaticTokenProvider } from '@mywebapi.com/sdk';

const init: CPluginWebApiClientInit = {
  env: 'custom',
  apiBaseUrl: 'https://api.example.test',
  authority: 'https://identity.example.test',
  clientId: 'fixture-client',
  clientSecret: 'fixture-secret',
  timeoutMs: 5_000,
};
const client = null as unknown as CPluginWebApiClient;
const time: Promise<string> = client.mt4.getServerTime('fixture-platform');
const realtime = new MT4V2SignalRClient({
  baseUrl: 'https://api.example.test',
  tradePlatform: 'fixture-platform',
  tokenProvider: new StaticTokenProvider('fixture-token'),
});
void init;
void time;
void realtime;