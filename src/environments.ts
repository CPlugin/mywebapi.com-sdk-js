// Environment presets for the v2 SDK. Presets carry only customer-facing
// base URLs — no internal hosts, tokens, or credentials.
export type EnvironmentName = 'prod' | 'staging' | 'custom';

export interface ResolvedEnvironment {
  apiBaseUrl: string;
  authority: string;
  allowInsecureLoopback?: boolean;
}

export type EnvironmentSelector =
  | { env: 'prod' | 'staging' }
  | { env: 'custom'; apiBaseUrl: string; authority: string; allowInsecureLoopback?: boolean };

const PRESETS: Record<'prod' | 'staging', ResolvedEnvironment> = {
  prod: { apiBaseUrl: 'https://cloud.mywebapi.com', authority: 'https://auth.cplugin.net' },
  staging: { apiBaseUrl: 'https://pre.mywebapi.com', authority: 'https://pre.auth.cplugin.net' },
};

function stripTrailingSlashes(value: string): string {
  let result = value;
  while (result.endsWith('/')) result = result.slice(0, -1);
  return result;
}

export function validateServiceUrl(raw: string, name: string, allowInsecureLoopback = false): string {
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    throw new TypeError(name + ' must be an absolute URL');
  }
  const loopback = parsed.hostname === 'localhost' || parsed.hostname === '127.0.0.1' || parsed.hostname === '[::1]';
  if (parsed.protocol !== 'https:' && !(allowInsecureLoopback && loopback && parsed.protocol === 'http:')) {
    throw new TypeError(name + ' must use HTTPS (HTTP is allowed only for explicit loopback tests)');
  }
  if (parsed.username || parsed.password) throw new TypeError(name + ' must not contain credentials');
  return stripTrailingSlashes(parsed.toString());
}

export function resolveEnvironment(sel: EnvironmentSelector): ResolvedEnvironment {
  if (sel.env === 'custom') {
    const allowInsecureLoopback = sel.allowInsecureLoopback === true;
    return {
      apiBaseUrl: validateServiceUrl(sel.apiBaseUrl, 'apiBaseUrl', allowInsecureLoopback),
      authority: validateServiceUrl(sel.authority, 'authority', allowInsecureLoopback),
      ...(allowInsecureLoopback ? { allowInsecureLoopback: true } : {}),
    };
  }
  const preset = PRESETS[sel.env];
  return { ...preset };
}