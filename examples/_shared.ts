// * Shared helpers for all SDK examples.
//
// Exports three building blocks used by every example script:
//   - requireEnv        — read a required env var or exit with a clear message
//   - buildClientFromEnv — construct CPluginWebApiClient from the four standard env vars
//   - resolveTradePlatform — pick the trade platform, auto-selecting when there is exactly one
//
// ! WEBAPI_TRADE_PLATFORM is OPTIONAL.
//   If you have exactly one trade platform it is selected automatically.
//   If you have several, set WEBAPI_TRADE_PLATFORM to one of the listed IDs.
//   Manage platforms at:
//     staging → https://pre.toolbox.cplugin.com
//     prod    → https://toolbox.cplugin.com

import { CPluginWebApiClient } from '../src/index';
import type { TradePlatform } from '../src/index';

// ---------------------------------------------------------------------------
// requireEnv
// ---------------------------------------------------------------------------

// * Reads an env var and exits immediately if it is missing.
//   Prints all four required credentials on any failure so the user can fix
//   everything in one go rather than discovering missing vars one at a time.
export function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    console.error(`Missing required environment variable: ${name}`);
    console.error('');
    console.error('Required variables:');
    console.error('  WEBAPI_BASE_URL      — API server base URL');
    console.error('  WEBAPI_AUTH_SERVER   — OAuth2 authority URL');
    console.error('  WEBAPI_CLIENT_ID     — OAuth2 client_id');
    console.error('  WEBAPI_CLIENT_SECRET — OAuth2 client_secret');
    console.error('');
    console.error('Optional:');
    console.error('  WEBAPI_TRADE_PLATFORM — trade platform GUID (auto-selected when you have exactly one)');
    process.exit(1);
  }
  return value;
}

// ---------------------------------------------------------------------------
// buildClientFromEnv
// ---------------------------------------------------------------------------

// * Reads the four required credential env vars and returns a ready-to-use
//   CPluginWebApiClient. The client caches the OAuth2 token internally and
//   refreshes it automatically — create one instance per process.
export function buildClientFromEnv(): CPluginWebApiClient {
  const apiBaseUrl   = requireEnv('WEBAPI_BASE_URL');
  const authority    = requireEnv('WEBAPI_AUTH_SERVER');
  const clientId     = requireEnv('WEBAPI_CLIENT_ID');
  const clientSecret = requireEnv('WEBAPI_CLIENT_SECRET');

  return new CPluginWebApiClient({
    env: 'custom',
    apiBaseUrl,
    authority,
    clientId,
    clientSecret,
  });
}

// ---------------------------------------------------------------------------
// resolveTradePlatform
// ---------------------------------------------------------------------------

// * Determines which trade platform to use, following these rules:
//
//   1. If WEBAPI_TRADE_PLATFORM is set → use it as an explicit override.
//      This lets users pin a specific platform without discovery overhead.
//
//   2. Otherwise call listTradePlatforms() and branch on the count:
//      - 0 platforms → print a helpful message and exit(1).
//      - 1 platform  → auto-select it and print the choice so the user
//                       can confirm at a glance which platform is active.
//      - 2+ platforms → list every option with ID / name / type and exit(1)
//                        requiring the user to set WEBAPI_TRADE_PLATFORM.
//                        Auto-picking from multiple platforms is intentionally
//                        refused — examples 02 and 03 affect live data and
//                        the wrong platform choice could be consequential.
export async function resolveTradePlatform(client: CPluginWebApiClient): Promise<string> {
  // * Explicit override — skip discovery entirely.
  const explicit = process.env['WEBAPI_TRADE_PLATFORM'];
  if (explicit) {
    console.log(`Using WEBAPI_TRADE_PLATFORM=${explicit}`);
    return explicit;
  }

  // * Discover what platforms are available for these credentials.
  let platforms: TradePlatform[];
  try {
    platforms = await client.listTradePlatforms();
  } catch (err) {
    console.error('Failed to list trade platforms:', err instanceof Error ? err.message : String(err));
    process.exit(1);
  }

  if (platforms.length === 0) {
    // ! No platforms at all — the credential either has no access or the account is empty.
    console.error('No trade platforms found on this account.');
    console.error('Create one in the Toolbox:');
    console.error('  staging → https://pre.toolbox.cplugin.com');
    console.error('  prod    → https://toolbox.cplugin.com');
    process.exit(1);
  }

  if (platforms.length === 1) {
    // * Exactly one platform — select it automatically. Print the choice so
    //   the user can confirm the right platform was picked without reading docs.
    const p = platforms[0]!;
    const id   = p.id   ?? '';
    const name = p.name ?? '(unnamed)';
    console.log(`Auto-selected your only trade platform: ${id} (${name})`);
    return id;
  }

  // ! More than one platform — require an explicit choice.
  //   We deliberately do NOT pick the first one: the wrong platform on example 03
  //   (--live) would place real orders on the wrong broker server.
  console.error(`You have ${platforms.length} trade platforms; set WEBAPI_TRADE_PLATFORM to one of:`);
  for (const p of platforms) {
    const id       = p.id   ?? '(no id)';
    const name     = p.name ?? '(unnamed)';
    const typeStr  = p.type != null ? String(p.type) : '?';
    console.error(`  - ${id}  ${name} [${typeStr}]`);
  }
  process.exit(1);
}
