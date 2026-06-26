// * Environment presets for the v2 SDK. Presets carry only customer-facing
//   base URLs — no internal hosts, tokens, or credentials.
export type EnvironmentName = 'prod' | 'staging' | 'custom';

export interface ResolvedEnvironment {
  apiBaseUrl: string;
  authority: string;
}

export type EnvironmentSelector =
  | { env: 'prod' | 'staging' }
  | { env: 'custom'; apiBaseUrl: string; authority: string };

const PRESETS: Record<'prod' | 'staging', ResolvedEnvironment> = {
  prod: { apiBaseUrl: 'https://cloud.mywebapi.com', authority: 'https://auth.cplugin.net' },
  staging: { apiBaseUrl: 'https://pre.mywebapi.com', authority: 'https://pre.auth.cplugin.net' },
};

const stripSlash = (u: string): string => u.replace(/\/+$/, '');

export function resolveEnvironment(sel: EnvironmentSelector): ResolvedEnvironment {
  if (sel.env === 'custom') {
    return { apiBaseUrl: stripSlash(sel.apiBaseUrl), authority: stripSlash(sel.authority) };
  }
  const preset = PRESETS[sel.env];
  return { apiBaseUrl: preset.apiBaseUrl, authority: preset.authority };
}
