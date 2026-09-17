import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const consumerRoot = process.env.SDK_CONSUMER_ROOT ?? process.cwd();
const require = createRequire(pathToFileURL(resolve(consumerRoot, 'package.json')));
const sdk = await import(require.resolve('@mywebapi.com/sdk'));
const requiredExports = ['CPluginWebApiClient', 'ApiError', 'MT4V2SignalRClient', 'MT5V2SignalRClient'];
for (const name of requiredExports) {
  if (typeof sdk[name] !== 'function') throw new Error(`missing consumer export: ${name}`);
}
const entry = require.resolve('@mywebapi.com/sdk');
if (!entry.endsWith('/dist/node/index.js')) throw new Error(`unexpected Node consumer entry: ${entry}`);
console.log(JSON.stringify({ runtime: typeof Bun === 'undefined' ? 'node' : 'bun', entry, exports: requiredExports }));
