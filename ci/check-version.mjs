import { readFile } from 'node:fs/promises';

const expected = process.argv[2] ?? process.env.RELEASE_VERSION;
if (!expected) throw new Error('expected release version argument is required');
if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(expected)) throw new Error(`invalid semver release version: ${expected}`);
const manifest = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
if (manifest.name !== '@mywebapi.com/sdk') throw new Error(`unexpected package name: ${manifest.name}`);
if (manifest.version !== expected) throw new Error(`source package version ${manifest.version} does not match release version ${expected}`);
console.log(JSON.stringify({ package: manifest.name, version: manifest.version }));
