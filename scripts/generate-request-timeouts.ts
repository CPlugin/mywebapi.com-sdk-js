// Extracts the per-operation server timeouts from spec/v2.json into
// src/request-timeouts.generated.ts.
//
// The server documents, on every operation it guards with a deadline, an
// `X-Request-Timeout` header parameter whose schema carries the default for that
// operation and the accepted range. orval does not emit header parameters for the
// fetch client, so the table is extracted here and read by the transport:
//   - the client deadline is kept longer than the server's own timeout, so the
//     server's answer (Timeout / OutcomeUnknown / Busy) arrives instead of a local abort;
//   - a client-wide requestTimeout is sent only to operations that accept it.
//
// Run through `bun run generate` (after orval) — never edit the output by hand.
// tests/request-timeout.test.ts fails when the output drifts from the spec.

import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export const TIMEOUT_HEADER = 'X-Request-Timeout';

export interface ExtractedTimeouts {
  min: number;
  max: number;
  operations: Array<readonly [method: string, path: string, seconds: number]>;
}

interface SpecParameter {
  name?: string;
  in?: string;
  schema?: { default?: unknown; minimum?: unknown; maximum?: unknown };
}

type SpecPaths = Record<string, Record<string, { parameters?: SpecParameter[] } | unknown>>;

const VERBS = new Set(['get', 'put', 'post', 'delete', 'options', 'head', 'patch', 'trace']);

export function extractTimeouts(spec: { paths?: SpecPaths }): ExtractedTimeouts {
  const operations: Array<readonly [string, string, number]> = [];
  const mins = new Set<number>();
  const maxs = new Set<number>();

  for (const [path, item] of Object.entries(spec.paths ?? {})) {
    for (const [verb, operation] of Object.entries(item)) {
      if (!VERBS.has(verb) || !operation || typeof operation !== 'object') continue;
      const parameters = (operation as { parameters?: SpecParameter[] }).parameters ?? [];
      const header = parameters.find((p) => p.in === 'header' && p.name?.toLowerCase() === TIMEOUT_HEADER.toLowerCase());
      if (!header) continue;
      const { default: seconds, minimum, maximum } = header.schema ?? {};
      if (typeof seconds !== 'number' || typeof minimum !== 'number' || typeof maximum !== 'number') {
        throw new Error(`${verb.toUpperCase()} ${path}: ${TIMEOUT_HEADER} must carry numeric default, minimum and maximum`);
      }
      operations.push([verb.toUpperCase(), path, seconds] as const);
      mins.add(minimum);
      maxs.add(maximum);
    }
  }

  if (operations.length === 0) throw new Error(`spec documents no ${TIMEOUT_HEADER} parameter`);
  if (mins.size !== 1 || maxs.size !== 1) {
    throw new Error(`${TIMEOUT_HEADER} range differs between operations: min ${[...mins]} max ${[...maxs]}`);
  }
  operations.sort((a, b) => (a[1] === b[1] ? a[0].localeCompare(b[0]) : a[1].localeCompare(b[1])));
  return { min: [...mins][0]!, max: [...maxs][0]!, operations };
}

export function renderTimeouts(extracted: ExtractedTimeouts): string {
  const rows = extracted.operations
    .map(([method, path, seconds]) => `  [${JSON.stringify(method)}, ${JSON.stringify(path)}, ${seconds}],`)
    .join('\n');
  return `// Generated from spec/v2.json by scripts/generate-request-timeouts.ts — do not edit.
// Server-side default timeout, in seconds, of every operation that accepts X-Request-Timeout.

/** Smallest X-Request-Timeout the server accepts, in seconds. */
export const REQUEST_TIMEOUT_MIN_SECONDS = ${extracted.min};

/** Largest X-Request-Timeout the server accepts, in seconds. */
export const REQUEST_TIMEOUT_MAX_SECONDS = ${extracted.max};

/** [HTTP method, OpenAPI path template, default timeout in seconds]. */
export const OPERATION_TIMEOUTS: ReadonlyArray<readonly [method: string, path: string, seconds: number]> = [
${rows}
];
`;
}

export const SPEC_PATH = join(import.meta.dir, '..', 'spec', 'v2.json');
export const OUTPUT_PATH = join(import.meta.dir, '..', 'src', 'request-timeouts.generated.ts');

if (import.meta.main) {
  const spec = JSON.parse(readFileSync(SPEC_PATH, 'utf8')) as { paths?: SpecPaths };
  const extracted = extractTimeouts(spec);
  writeFileSync(OUTPUT_PATH, renderTimeouts(extracted));
  console.log(`request timeouts: ${extracted.operations.length} operations, range ${extracted.min}–${extracted.max} s`);
}
