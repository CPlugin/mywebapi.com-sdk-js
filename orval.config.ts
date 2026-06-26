import { defineConfig } from 'orval';

// * orval config for the v2 TypeScript SDK.
// ! Operations in v2.json have NO operationId (verified 0/159); orval derives
//   method names from path + HTTP verb. Grouping is by tag (mode: 'tags'),
//   where tags are "MT4 v2 :: <Group>" / "MT5 v2 :: <Group>".

// * Strip the shared route prefix so generated function names are concise.
//
//   orval normalises OpenAPI path params from {param} to ${param} (JS template-
//   literal syntax) before invoking operationName, so the actual route value is:
//     /api/v2/MT4/${tradePlatform}/ServerTime
//     /api/v2/MT4/${tradePlatform}/UserRecord/${login}
//
//   This transform strips the platform prefix and produces:
//     getServerTime
//     getUserRecordLogin
//
// Remaining path-param segments (${symbol}, ${login}, …) are kept and
// converted to PascalCase so that names stay unique where the spec has
// per-param variants (e.g. /UserRecord/${login} vs /UserRecordsRequest).
//
// ! Cross-platform collision guard: a small set of endpoints share the same
//   path suffix on both MT4 and MT5 (e.g. /ServerTime, /GroupRecord/{group},
//   /UserRecord/{login}). orval's global operation-key dedup silently drops the
//   MT4 variant when it produces the same name as the MT5 variant (MT4 paths
//   come first in the spec so MT4 wins the key; MT5 gets key suffix ::2 but
//   its implementation is still written — the MT4 variant is what gets lost).
//   Resolution: include the platform literal (Mt4 / Mt5) as a suffix on these
//   known-collision names. The set is small and stable — it covers the three
//   paths that are truly symmetric between both platforms.
const CROSS_PLATFORM_COLLISION_SUFFIXES = new Set([
  '/ServerTime',
  '/GroupRecord',       // also covers /GroupRecord/${group}
  '/UserRecord',        // also covers /UserRecord/${login} PATCH variant
]);

function cleanOperationName(_op: unknown, route: string, verb: string): string {
  // * Detect platform (MT4 / MT5) from the route before stripping the prefix.
  const platformMatch = route.match(/^\/api\/v2\/(MT[45])\//i);
  const platform = platformMatch ? platformMatch[1] : '';

  // * Remove the common /api/v2/MT4/${tradePlatform} or /api/v2/MT5/${tradePlatform}
  //   prefix. The platform is already encoded in the namespace (client.mt4/mt5).
  const tail = route.replace(/^\/api\/v2\/MT[45]\/\$\{tradePlatform\}/i, '');

  // * Build the name from the remaining segments:
  //   - Static segments: "ServerTime" stays "ServerTime"
  //   - Param segments: "${login}" → strip braces → "login" → "Login"
  const name = tail
    .replace(/\$\{(\w+)\}/g, '$1')   // ${login} → login, ${symbol} → symbol
    .split('/')
    .filter(Boolean)
    .map((s) => s.charAt(0).toUpperCase() + s.slice(1))
    .join('');

  // * Append the platform literal as disambiguator for the handful of endpoints
  //   whose path suffix is identical on both MT4 and MT5. This prevents orval's
  //   global key dedup from silently dropping the MT4 variant of each pair.
  const needsPlatform = platform && [...CROSS_PLATFORM_COLLISION_SUFFIXES].some((suffix) =>
    tail === suffix || tail.startsWith(suffix + '/') || tail.startsWith(suffix + '$'),
  );

  const disambiguated = needsPlatform ? `${name}${platform}` : name;
  return `${String(verb).toLowerCase()}${disambiguated}`;
}

export default defineConfig({
  cplugin: {
    input: {
      target: './spec/v2.json',
    },
    output: {
      mode: 'tags',
      target: './src/generated/endpoints.ts',
      schemas: './src/generated/model',
      client: 'fetch',
      httpClient: 'fetch',
      // * Carry OpenAPI summary/description into generated JSDoc.
      docs: true,
      clean: true,
      prettier: false,
      override: {
        mutator: {
          path: './src/mutator.ts',
          name: 'customFetch',
        },
        // * Clean generated function names: strip /api/v2/{platform}/{tradePlatform}
        //   so client.mt4.getServerTimeMT4(...) replaces getApiV2MT4TradePlatformServerTime(...).
        //   Cross-platform collisions get a Mt4/Mt5 suffix (see cleanOperationName).
        operationName: cleanOperationName,
      },
    },
  },
});
