// Token providers for the MT4V2Client. Two shapes are supported:
//   - StaticTokenProvider: caller already has a JWT (no renewal).
//   - ClientCredentialsTokenProvider: SDK fetches and renews tokens via
//     RFC 6749 §4.4 client_credentials, with discovery per RFC 8414 /
//     OpenID Connect Discovery 1.0.
//
// The provider is intentionally minimal: it has no concept of refresh tokens,
// scopes-per-request, or user identity. It exists to feed the client a fresh
// bearer string and survive a single in-flight renewal across concurrent callers.

export interface TokenProvider {
  /** Return a valid bearer token. May trigger a network call on first use or after expiry. */
  getToken(opts?: { forceRefresh?: boolean }): Promise<string>;
}

export class StaticTokenProvider implements TokenProvider {
  private readonly token: string;

  constructor(token: string) {
    this.token = token;
  }

  async getToken(_opts?: { forceRefresh?: boolean }): Promise<string> {
    return this.token;
  }
}

export interface ClientCredentialsOptions {
  clientId: string;
  clientSecret: string;
  /** IdentityServer base URL, e.g. `https://identity.example`. Discovery doc resolved as `${identityUrl}/.well-known/openid-configuration`. */
  identityUrl: string;
  scopes?: readonly string[];
  /** Inject a custom fetch (tests, instrumentation). Defaults to global `fetch`. */
  fetch?: typeof fetch;
  /** Treat a token as expired this many seconds before its true expiry. RFC 6749 §10.4 — buffer for clock drift + flight time. */
  clockSkewSeconds?: number;
}

interface CachedToken {
  accessToken: string;
  /** Absolute ms timestamp (Date.now()) at which the token truly expires. Skew is subtracted at read-time. */
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
    super(`OAuth2 token error (${code}): ${desc}`);
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
  private readonly scopes: readonly string[] | undefined;
  private readonly fetchFn: typeof fetch;
  private readonly clockSkewMs: number;

  private cached: CachedToken | null = null;
  private discoveryPromise: Promise<Discovery> | null = null;
  // Single-flight: while a refresh is in flight, every concurrent getToken()
  // joins the same promise instead of triggering a stampede on the IdP.
  private refreshPromise: Promise<CachedToken> | null = null;

  constructor(opts: ClientCredentialsOptions) {
    this.clientId = opts.clientId;
    this.clientSecret = opts.clientSecret;
    this.identityUrl = opts.identityUrl.replace(/\/+$/, '');
    this.scopes = opts.scopes;
    this.fetchFn = opts.fetch ?? fetch;
    this.clockSkewMs = (opts.clockSkewSeconds ?? 60) * 1000;
  }

  async getToken(opts?: { forceRefresh?: boolean }): Promise<string> {
    if (!opts?.forceRefresh && this.cached && this.cached.expiresAt - Date.now() > this.clockSkewMs) {
      return this.cached.accessToken;
    }
    if (this.refreshPromise) {
      const result = await this.refreshPromise;
      return result.accessToken;
    }
    this.refreshPromise = this.acquireToken();
    try {
      const result = await this.refreshPromise;
      this.cached = result;
      return result.accessToken;
    } finally {
      this.refreshPromise = null;
    }
  }

  private async acquireToken(): Promise<CachedToken> {
    const { tokenEndpoint } = await this.getDiscovery();

    const body = new URLSearchParams();
    body.set('grant_type', 'client_credentials');
    body.set('client_id', this.clientId);
    body.set('client_secret', this.clientSecret);
    if (this.scopes && this.scopes.length > 0) {
      body.set('scope', this.scopes.join(' '));
    }

    const res = await this.fetchFn(tokenEndpoint, {
      method: 'POST',
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
    if (typeof json.access_token !== 'string' || typeof json.expires_in !== 'number') {
      throw new OAuth2TokenError({
        status: res.status,
        errorCode: 'invalid_response',
        errorDescription: 'Token endpoint returned malformed JSON (missing access_token or expires_in).',
        ...(requestId !== undefined ? { requestId } : {}),
      });
    }

    return {
      accessToken: json.access_token,
      expiresAt: Date.now() + json.expires_in * 1000,
    };
  }

  private async getDiscovery(): Promise<Discovery> {
    if (this.discoveryPromise) {
      return this.discoveryPromise;
    }
    // Store the promise (not the value) so concurrent callers share a single
    // discovery roundtrip. On failure we clear it so the next call can retry —
    // a permanently rejected promise would poison the provider.
    this.discoveryPromise = this.fetchDiscovery().catch((err) => {
      this.discoveryPromise = null;
      throw err;
    });
    return this.discoveryPromise;
  }

  private async fetchDiscovery(): Promise<Discovery> {
    const url = `${this.identityUrl}/.well-known/openid-configuration`;
    const res = await this.fetchFn(url, { method: 'GET', headers: { Accept: 'application/json' } });
    if (!res.ok) {
      throw new OAuth2TokenError({
        status: res.status,
        errorCode: 'discovery_failed',
        errorDescription: `Discovery endpoint ${url} returned HTTP ${res.status}.`,
      });
    }
    const json = (await res.json()) as { token_endpoint?: unknown };
    if (typeof json.token_endpoint !== 'string') {
      throw new OAuth2TokenError({
        status: res.status,
        errorCode: 'discovery_invalid',
        errorDescription: 'Discovery document missing or invalid `token_endpoint`.',
      });
    }
    return { tokenEndpoint: json.token_endpoint };
  }
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
  // Non-JSON body: surface a redacted excerpt. `client_secret` would only
  // appear here if the server echoed our request body in an error page —
  // unlikely but cheap to defend against.
  const excerpt = text.slice(0, 500).replace(/client_secret=[^&\s]*/gi, 'client_secret=<redacted>');
  return { errorDescription: excerpt };
}
