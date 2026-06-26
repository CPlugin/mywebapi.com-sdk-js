import { describe, expect, test } from 'bun:test';
import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const GEN = join(import.meta.dir, '..', 'src', 'generated');

function collectTs(dir: string): string[] {
  const out: string[] = [];
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) out.push(...collectTs(p));
    else if (e.name.endsWith('.ts')) out.push(p);
  }
  return out;
}

describe('orval generated output', () => {
  test('generated directory exists with model + endpoint files', () => {
    expect(existsSync(GEN)).toBe(true);
    // * tags mode emits one file per tag group plus a model directory
    expect(readdirSync(GEN).length).toBeGreaterThan(1);
  });

  test('every generated source routes through customFetch, never axios/ky', () => {
    const all = collectTs(GEN);
    expect(all.length).toBeGreaterThan(0);
    const blob = all.map((f) => readFileSync(f, 'utf8')).join('\n');
    expect(blob).toContain('customFetch');
    expect(blob).not.toContain("from 'axios'");
    expect(blob).not.toContain('import ky');
  });

  test('carries OpenAPI summaries as JSDoc (Get server time)', () => {
    const blob = collectTs(GEN).map((f) => readFileSync(f, 'utf8')).join('\n');
    expect(blob).toContain('Get server time');
  });

  test('generated surface has at least 159 endpoint functions (spec drift guard)', () => {
    // * Count exported async arrow functions in non-model files.
    //   Matches orval's output pattern: `export const <camelName> = async`.
    //   Model files (in the model/ subdirectory) export types only, so they
    //   are excluded from the count.
    const endpointFiles = collectTs(GEN).filter((f) => !f.includes(`${join(GEN, 'model')}`));
    const blob = endpointFiles.map((f) => readFileSync(f, 'utf8')).join('\n');
    const matches = blob.match(/^export const [a-z][A-Za-z0-9]+ = async/gm) ?? [];
    const count = matches.length;
    // * Log the actual count so CI output makes drift visible.
    console.log(`Generated endpoint function count: ${count}`);
    expect(count).toBeGreaterThanOrEqual(159);
  });
});
