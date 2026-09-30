// Token providers for the MT4/MT5 SDK.
//
// ClientCredentialsTokenProvider implements RFC 6749 client credentials with
// OIDC discovery. Token acquisition is single-flight: cancellation only rejects
// the caller that requested it and never aborts the shared acquisition used by
// other waiters.

import { withDeadline } from './deadline';

export interface TokenProvider {
  /** Return a valid bearer token. May trigger a network call on first use or after expiry. */
  getToken(opts?: { forceRefresh?: boolean; signal?: AbortSignal }): Promise<string>;
}

export class StaticTokenProvider implements TokenProvider {
  private readonly token: string;

  constructor(token: string) {
    this.token = token;
  }

  async getToken(_opts?: { forceRefresh?: boolean; signal?: AbortSignal }): Promise<string> {
    return this.token;
  }
}

export interface ClientCredentialsOptions {
  clientId: string;
  clientSecret: string;
  /** IdentityServer base URL. Discovery is resolved below this origin. */
  identityUrl: string;
  scopes?: readonly string[];
  /** Inject a custom fetch (tests, instrumentation). Defaults to global fetch. */
  fetch?: typeof fetch;
  /** Treat a token as expired this many seconds before its true expiry. */
  clockSkewSeconds?: number;
  /** Per-discovery/token-request deadline. Defaults to 30 seconds. */
  timeoutMs?: number;
  /** Only tests may opt into plain HTTP on loopback hosts. */
  allowInsecureLoopback?: boolean;
}

interface CachedToken {
  accessToken: string;
  expiresAt: number;
}

interface Discovery {
  tokenEndpoint: string;
}

export class OAuth2TokenError extends Error {
  readonly status: number;
  readonly errorCode: string | undefined;
  readonly errorDescription: string | undefined;
  readonly requestId: string | undefined;

  constructor(opts: { status: number; errorCode?: string; errorDescription?: string; requestId?: string }) {
    const code = opts.errorCode ?? String(opts.status);
    const desc = opts.errorDescription ?? '<no description>';
    super('OAuth2 token error (' + code + '): ' + desc);
    this.name = 'OAuth2TokenError';
    this.status = opts.status;
    this.errorCode = opts.errorCode;
    this.errorDescription = opts.errorDescription;
    this.requestId = opts.requestId;
  }
}

export class ClientCredentialsTokenProvider implements TokenProvider {
  private readonly clientId: string;
  private readonly clientSecret: string;
  private readonly identityUrl: string;
  private readonly identityOrigin: string;
  private readonly scopes: readonly string[] | undefined;
  private readonly fetchFn: typeof fetch;
  private readonly clockSkewMs: number;
  private readonly timeoutMs: number;
  private readonly allowInsecureLoopback: boolean;

  private cached: CachedToken | null = null;
  private discoveryPromise: Promise<Discovery> | null = null;
  private refreshPromise: Promise<CachedToken> | null = null;

  constructor(opts: ClientCredentialsOptions) {
    this.clientId = opts.clientId;
    this.clientSecret = opts.clientSecret;
    this.allowInsecureLoopback = opts.allowInsecureLoopback === true;
    this.identityUrl = stripTrailingSlashes(validateHttpsUrl(opts.identityUrl, 'identityUrl', this.allowInsecureLoopback));
    this.identityOrigin = new URL(this.identityUrl).origin;
    this.scopes = opts.scopes;
    this.fetchFn = opts.fetch ?? globalThis.fetch.bind(globalThis);
    this.clockSkewMs = (opts.clockSkewSeconds ?? 60) * 1000;
    this.timeoutMs = opts.timeoutMs ?? 30_000;
    if (!Number.isFinite(this.timeoutMs) || this.timeoutMs <= 0) {
      throw new TypeError('timeoutMs must be a positive finite number');
    }
  }

  async getToken(opts?: { forceRefresh?: boolean; signal?: AbortSignal }): Promise<string> {
    if (!opts?.forceRefresh && this.cached && this.cached.expiresAt - Date.now() > this.clockSkewMs) {
      return this.cached.accessToken;
    }

    let refresh = this.refreshPromise;
    if (!refresh) {
      refresh = this.acquireToken();
      this.refreshPromise = refresh;
      // The shared acquisition owns cache and lifecycle. A caller abort only
      // rejects its own waitForAbortable() below, never this promise.
      void refresh.then(
        (result) => {
          this.cached = result;
          if (this.refreshPromise === refresh) this.refreshPromise = null;
        },
        () => {
          if (this.refreshPromise === refresh) this.refreshPromise = null;
        },
      );
    }

    const result = await waitForAbortable(refresh, opts?.signal);
    return result.accessToken;
  }

  private async acquireToken(): Promise<CachedToken> {
    const { tokenEndpoint } = await this.getDiscovery();

    const body = new URLSearchParams();
    body.set('grant_type', 'client_credentials');
    body.set('client_id', this.clientId);
    body.set('client_secret', this.clientSecret);
    if (this.scopes && this.scopes.length > 0) body.set('scope', this.scopes.join(' '));

    return withDeadline(this.timeoutMs, undefined, async (signal) => {
      const res = await this.fetchFn(tokenEndpoint, {
        method: 'POST',
        redirect: 'error',
        signal,
        headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
        body: body.toString(),
      });

      const requestId = res.headers.get('x-request-id') ?? undefined;
      if (!res.ok) {
        const errorPayload = await parseOAuthError(res);
        throw new OAuth2TokenError({
          status: res.status,
          ...(errorPayload.errorCode !== undefined ? { errorCode: errorPayload.errorCode } : {}),
          ...(errorPayload.errorDescription !== undefined ? { errorDescription: errorPayload.errorDescription } : {}),
          ...(requestId !== undefined ? { requestId } : {}),
        });
      }

      const json = (await res.json()) as { access_token?: unknown; expires_in?: unknown };
      if (typeof json.access_token !== 'string' || typeof json.expires_in !== 'number' || json.expires_in <= 0) {
        throw new OAuth2TokenError({
          status: res.status,
          errorCode: 'invalid_response',
          errorDescription: 'Token endpoint returned malformed JSON (missing access_token or expires_in).',
          ...(requestId !== undefined ? { requestId } : {}),
        });
      }
      return { accessToken: json.access_token, expiresAt: Date.now() + json.expires_in * 1000 };
    });
  }

  private async getDiscovery(): Promise<Discovery> {
    if (!this.discoveryPromise) {
      const discovery = this.fetchDiscovery();
      this.discoveryPromise = discovery;
      void discovery.then(
        () => undefined,
        () => {
          if (this.discoveryPromise === discovery) this.discoveryPromise = null;
        },
      );
    }
    return this.discoveryPromise;
  }

  private async fetchDiscovery(): Promise<Discovery> {
    const url = this.identityUrl + '/.well-known/openid-configuration';
    return withDeadline(this.timeoutMs, undefined, async (signal) => {
      const res = await this.fetchFn(url, {
        method: 'GET',
        redirect: 'error',
        signal,
        headers: { Accept: 'application/json' },
      });
      if (!res.ok) {
        throw new OAuth2TokenError({
          status: res.status,
          errorCode: 'discovery_failed',
          errorDescription: 'Discovery endpoint returned HTTP ' + res.status + '.',
        });
      }
      const json = (await res.json()) as { token_endpoint?: unknown };
      if (typeof json.token_endpoint !== 'string') {
        throw new OAuth2TokenError({
          status: res.status,
          errorCode: 'discovery_invalid',
          errorDescription: 'Discovery document missing or invalid token_endpoint.',
        });
      }
      const tokenEndpoint = validateHttpsUrl(json.token_endpoint, 'token_endpoint', this.allowInsecureLoopback);
      if (new URL(tokenEndpoint).origin !== this.identityOrigin) {
        throw new OAuth2TokenError({
          status: res.status,
          errorCode: 'discovery_invalid',
          errorDescription: 'Discovery token_endpoint must use the identityUrl origin.',
        });
      }
      return { tokenEndpoint };
    });
  }
}

function stripTrailingSlashes(value: string): string {
  let result = value;
  while (result.endsWith('/')) result = result.slice(0, -1);
  return result;
}

function validateHttpsUrl(raw: string, name: string, allowInsecureLoopback = false): string {
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

function waitForAbortable<T>(promise: Promise<T>, signal: AbortSignal | undefined): Promise<T> {
  if (!signal) return promise;
  // Listen on a private composite so cleanup never removes the caller's last
  // listener and accidentally cancels a runtime-managed timeout signal.
  const waitSignal = AbortSignal.any([signal]);
  if (waitSignal.aborted) return Promise.reject(waitSignal.reason ?? new DOMException('Aborted', 'AbortError'));
  return new Promise<T>((resolve, reject) => {
    const onAbort = (): void => {
      cleanup();
      reject(waitSignal.reason ?? new DOMException('Aborted', 'AbortError'));
    };
    const cleanup = (): void => waitSignal.removeEventListener('abort', onAbort);
    waitSignal.addEventListener('abort', onAbort, { once: true });
    promise.then((value) => { cleanup(); resolve(value); }, (error) => { cleanup(); reject(error); });
  });
}

async function parseOAuthError(res: Response): Promise<{ errorCode?: string; errorDescription?: string }> {
  const text = await res.text();
  if (!text) return {};
  try {
    const json = JSON.parse(text) as { error?: unknown; error_description?: unknown };
    const out: { errorCode?: string; errorDescription?: string } = {};
    if (typeof json.error === 'string') out.errorCode = json.error;
    if (typeof json.error_description === 'string') out.errorDescription = json.error_description;
    if (out.errorCode || out.errorDescription) return out;
  } catch {
    // fall through to body excerpt
  }
  const excerpt = text.slice(0, 500).replace(/client_secret=[^&\s]*/gi, 'client_secret=<redacted>');
  return { errorDescription: excerpt };
}
