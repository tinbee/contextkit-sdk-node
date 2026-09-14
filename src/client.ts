import { ApiError, TokenRevokedError, ValidationError } from "./errors.js";
import { type FetchLike, type HttpOptions, UnauthorizedSignal, request } from "./http.js";
import { codeChallenge } from "./pkce.js";
import { type AppScope, type TokenResponse, type TokenSet, isAppScope } from "./types.js";
import { UserClient, type UserClientOptions, type UserTokens } from "./user.js";

export const DEFAULT_API_BASE_URL = "https://api.contextkit.com";
export const DEFAULT_AUTHORIZE_BASE_URL = "https://contextkit.com";
export const DEFAULT_TIMEOUT_MS = 10_000;

declare const __SDK_VERSION__: string | undefined;
const VERSION = typeof __SDK_VERSION__ === "string" ? __SDK_VERSION__ : "dev";

export interface ContextKitOptions {
  /** The app's client id (a UUID) from the developer portal. */
  clientId: string;
  /** The app's client secret. Server-side only — never ship this to a browser. */
  clientSecret: string;
  /** Defaults to https://api.contextkit.com */
  apiBaseUrl?: string;
  /** Where users are sent to consent. Defaults to https://contextkit.com */
  authorizeBaseUrl?: string;
  /** Per-request timeout. Defaults to 10s. */
  timeoutMs?: number;
  /** Injectable for tests; defaults to global fetch (Node 20+). */
  fetch?: FetchLike;
}

export interface AuthorizeUrlParams {
  /** Must be one of the redirect URIs registered for the app. */
  redirectUri: string;
  scopes: readonly AppScope[];
  /** Opaque, unguessable, bound to the user's session. Echoed back on the
   *  redirect; refuse the callback if it does not match. */
  state: string;
  /** Keep the verifier in the user's session; the challenge is derived here. */
  codeVerifier: string;
  /** Your own id for this user. Stored on the grant and shown to you in the
   *  portal's Users tab. Optional; never shown to the user. */
  externalUserId?: string;
}

export interface ExchangeCodeParams {
  code: string;
  codeVerifier: string;
  redirectUri: string;
}

/**
 * One instance per app. Holds the client credentials and builds per-user
 * handles with `forUser`.
 */
export class ContextKit {
  readonly clientId: string;
  readonly apiBaseUrl: string;
  readonly authorizeBaseUrl: string;
  private readonly clientSecret: string;
  private readonly http: HttpOptions;

  constructor(options: ContextKitOptions) {
    if (!options.clientId) throw new Error("ContextKit: clientId is required");
    if (!options.clientSecret) throw new Error("ContextKit: clientSecret is required");
    this.clientId = options.clientId;
    this.clientSecret = options.clientSecret;
    this.apiBaseUrl = stripSlash(options.apiBaseUrl ?? DEFAULT_API_BASE_URL);
    this.authorizeBaseUrl = stripSlash(options.authorizeBaseUrl ?? DEFAULT_AUTHORIZE_BASE_URL);
    const fetchImpl = options.fetch ?? (globalThis.fetch as unknown as FetchLike | undefined);
    if (!fetchImpl) throw new Error("ContextKit: no fetch available; pass options.fetch");
    this.http = {
      fetchImpl,
      timeoutMs: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
      userAgent: `contextkit-sdk/${VERSION} node/${process.versions.node}`,
    };
  }

  /** The URL to send the user to. */
  authorizeUrl(params: AuthorizeUrlParams): string {
    if (params.scopes.length === 0) throw new Error("authorizeUrl: at least one scope is required");
    for (const scope of params.scopes) {
      if (!isAppScope(scope)) throw new Error(`authorizeUrl: unknown scope "${String(scope)}"`);
    }
    if (!params.state) throw new Error("authorizeUrl: state is required");
    if (params.codeVerifier.length < 43 || params.codeVerifier.length > 128) {
      throw new Error(
        "authorizeUrl: codeVerifier must be 43–128 characters (see generateCodeVerifier)",
      );
    }
    const url = new URL(`${this.authorizeBaseUrl}/authorize`);
    // RFC 6749 §4.1.1 requires it, and the consent page refuses a link
    // without it.
    url.searchParams.set("response_type", "code");
    url.searchParams.set("client_id", this.clientId);
    url.searchParams.set("redirect_uri", params.redirectUri);
    url.searchParams.set("scope", params.scopes.join(" "));
    url.searchParams.set("code_challenge", codeChallenge(params.codeVerifier));
    url.searchParams.set("code_challenge_method", "S256");
    url.searchParams.set("state", params.state);
    if (params.externalUserId) url.searchParams.set("external_user_id", params.externalUserId);
    return url.toString();
  }

  /** Callback step: trade the code for tokens. Persist the result per user. */
  async exchangeCode(params: ExchangeCodeParams): Promise<TokenSet> {
    return this.token({
      grantType: "authorization_code",
      code: params.code,
      codeVerifier: params.codeVerifier,
      redirectUri: params.redirectUri,
    });
  }

  /**
   * Refresh explicitly. `forUser` does this for you; call it directly only
   * for a scheduled refresh. Refresh tokens rotate — persist the new set.
   */
  async refresh(refreshToken: string): Promise<TokenSet> {
    return this.token({ grantType: "refresh_token", refreshToken });
  }

  /**
   * End a user's connection (RFC 7009). Revokes the WHOLE grant the token
   * belongs to — every access and refresh token, every rule — not just the
   * token passed. Either kind of token works. Resolves for an unknown,
   * expired or already-revoked token too: revocation is idempotent, and the
   * API deliberately does not say which it was. `forUser(...).disconnect()`
   * is the usual entry point; call this directly when all you have left is
   * a stored token.
   */
  async revokeToken(token: string): Promise<void> {
    if (!token) throw new Error("revokeToken: token is required");
    try {
      await request<unknown>(this.http, {
        method: "POST",
        url: `${this.apiBaseUrl}/v1/oauth/revoke`,
        body: { clientId: this.clientId, clientSecret: this.clientSecret, token },
      });
    } catch (err) {
      // The only 401 this route gives is for the CLIENT credentials; the
      // token's own state never fails the call. So it is a configuration
      // error, not a revoked grant.
      if (err instanceof UnauthorizedSignal) {
        throw new ApiError("revokeToken: client credentials were rejected", 401, err.body);
      }
      throw err;
    }
  }

  /** A handle that makes calls as one connected user. */
  forUser(tokens: UserTokens, options: UserClientOptions = {}): UserClient {
    return new UserClient(
      this.http,
      this.apiBaseUrl,
      { refresh: (rt) => this.refresh(rt), revoke: (token) => this.revokeToken(token) },
      tokens,
      options,
    );
  }

  private async token(body: Record<string, string>): Promise<TokenSet> {
    let res: { data: TokenResponse };
    try {
      res = await request<TokenResponse>(this.http, {
        method: "POST",
        url: `${this.apiBaseUrl}/v1/oauth/token`,
        body: { clientId: this.clientId, clientSecret: this.clientSecret, ...body },
      });
    } catch (err) {
      // The token endpoint answers a dead refresh token or a bad code with
      // 400/401. Both mean "start over", so both become TokenRevokedError.
      if (err instanceof UnauthorizedSignal) throw new TokenRevokedError(undefined, err.body);
      if (err instanceof ValidationError && body.grantType === "refresh_token") {
        throw new TokenRevokedError(err.message, err.body);
      }
      throw err;
    }
    return toTokenSet(res.data);
  }
}

export function toTokenSet(raw: TokenResponse, now = Date.now()): TokenSet {
  return {
    accessToken: raw.access_token,
    accessTokenExpiresAt: now + raw.expires_in * 1000,
    refreshToken: raw.refresh_token,
    refreshTokenExpiresAt: raw.refresh_token_expires_at ?? null,
    scopes: raw.scope.split(" ").filter(isAppScope),
    sub: raw.sub ?? null,
    sensitiveScopesExpiresAt: epochMs(raw.sensitive_scopes_expire_at),
  };
}

function epochMs(iso: string | null | undefined): number | null {
  if (typeof iso !== "string") return null;
  const ms = Date.parse(iso);
  return Number.isNaN(ms) ? null : ms;
}

function stripSlash(url: string): string {
  return url.replace(/\/+$/, "");
}
