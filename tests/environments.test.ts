import { describe, expect, test } from 'bun:test';
import { resolveEnvironment } from '../src/environments';

describe('resolveEnvironment', () => {
  test('prod preset', () => {
    expect(resolveEnvironment({ env: 'prod' })).toEqual({
      apiBaseUrl: 'https://cloud.mywebapi.com',
      authority: 'https://auth.cplugin.net',
    });
  });
  test('staging preset', () => {
    expect(resolveEnvironment({ env: 'staging' })).toEqual({
      apiBaseUrl: 'https://pre.mywebapi.com',
      authority: 'https://pre.auth.cplugin.net',
    });
  });
  test('custom passes through and strips trailing slashes', () => {
    expect(
      resolveEnvironment({ env: 'custom', apiBaseUrl: 'http://localhost:5002/', authority: 'http://localhost:5001/' }),
    ).toEqual({ apiBaseUrl: 'http://localhost:5002', authority: 'http://localhost:5001' });
  });
});
