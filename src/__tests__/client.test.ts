import { ContextKit, toTokenSet } from "../client.js";
import { ApiError, TokenRevokedError, ValidationError } from "../errors.js";
import { fakeFetch, tokenBody } from "./fake-fetch.js";

const CLIENT_ID = "11111111-1111-4111-8111-111111111111";
const VERIFIER = "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk";

function client(fetch = fakeFetch(() => ({}))): ContextKit {
  return new ContextKit({
    clientId: CLIENT_ID,
    clientSecret: "shh",
    apiBaseUrl: "https://api.test/",
    authorizeBaseUrl: "https://app.test",
    fetch,
  });
}

describe("ContextKit.authorizeUrl", () => {
  it("builds the consent URL with snake_case params and an S256 challenge", () => {
    const url = new URL(
      client().authorizeUrl({
        redirectUri: "https://paperowl.test/cb",
        scopes: ["location.verify.zone", "location.visits.read"],
        state: "st-123",
        codeVerifier: VERIFIER,
        externalUserId: "user_42",
      }),
    );
    expect(url.origin + url.pathname).toBe("https://app.test/authorize");
    // The consent page refuses the link without it (RFC 6749 §4.1.1).
    expect(url.searchParams.get("response_type")).toBe("code");
    expect(url.searchParams.get("client_id")).toBe(CLIENT_ID);
    expect(url.searchParams.get("redirect_uri")).toBe("https://paperowl.test/cb");
    expect(url.searchParams.get("scope")).toBe("location.verify.zone location.visits.read");
    expect(url.searchParams.get("code_challenge")).toBe(
      "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM",
    );
    expect(url.searchParams.get("code_challenge_method")).toBe("S256");
    expect(url.searchParams.get("state")).toBe("st-123");
    expect(url.searchParams.get("external_user_id")).toBe("user_42");
  });

  it("refuses unknown scopes, a missing state, and a short verifier", () => {
    const base = { redirectUri: "https://x/cb", state: "s", codeVerifier: VERIFIER };
    expect(() => client().authorizeUrl({ ...base, scopes: ["location.nope" as never] })).toThrow(
      /unknown scope/,
    );
    expect(() =>
      client().authorizeUrl({ ...base, scopes: ["location.verify.zone"], state: "" }),
    ).toThrow(/state/);
    expect(() =>
      client().authorizeUrl({ ...base, scopes: ["location.verify.zone"], codeVerifier: "short" }),
    ).toThrow(/43/);
  });
});

describe("ContextKit.exchangeCode", () => {
  it("posts a camelCase token request and returns a TokenSet", async () => {
    const fetch = fakeFetch(() => ({ body: tokenBody({ sub: "sub-1" }) }));
    const before = Date.now();
    const tokens = await client(fetch).exchangeCode({
      code: "code-1",
      codeVerifier: VERIFIER,
      redirectUri: "https://paperowl.test/cb",
    });
    expect(fetch.calls[0]?.url).toBe("https://api.test/v1/oauth/token");
    expect(fetch.calls[0]?.method).toBe("POST");
    expect(fetch.calls[0]?.body).toEqual({
      clientId: CLIENT_ID,
      clientSecret: "shh",
      grantType: "authorization_code",
      code: "code-1",
      codeVerifier: VERIFIER,
      redirectUri: "https://paperowl.test/cb",
    });
    expect(tokens.accessToken).toBe("at-1");
    expect(tokens.refreshToken).toBe("rt-1");
    expect(tokens.scopes).toEqual(["location.verify.zone", "location.place.current"]);
    expect(tokens.sub).toBe("sub-1");
    expect(tokens.accessTokenExpiresAt).toBeGreaterThanOrEqual(before + 3600_000);
  });

  it("surfaces a bad code as ValidationError, not TokenRevoked", async () => {
    const fetch = fakeFetch(() => ({
      status: 400,
      body: { statusCode: 400, message: ["code invalid"] },
    }));
    await expect(
      client(fetch).exchangeCode({
        code: "x",
        codeVerifier: VERIFIER,
        redirectUri: "https://x/cb",
      }),
    ).rejects.toBeInstanceOf(ValidationError);
  });
});

describe("ContextKit.refresh", () => {
  it("turns a rejected refresh token into TokenRevokedError", async () => {
    for (const status of [400, 401]) {
      const fetch = fakeFetch(() => ({ status, body: { statusCode: status, message: "invalid" } }));
      await expect(client(fetch).refresh("dead")).rejects.toBeInstanceOf(TokenRevokedError);
    }
  });
});

describe("ContextKit.revokeToken", () => {
  it("posts the token with the client credentials and resolves with nothing", async () => {
    const fetch = fakeFetch(() => ({ status: 200 }));
    await expect(client(fetch).revokeToken("ckr_dead")).resolves.toBeUndefined();
    expect(fetch.calls[0]?.url).toBe("https://api.test/v1/oauth/revoke");
    expect(fetch.calls[0]?.body).toEqual({
      clientId: CLIENT_ID,
      clientSecret: "shh",
      token: "ckr_dead",
    });
  });

  it("turns the route's only 401 — bad client credentials — into ApiError, not TokenRevoked", async () => {
    const fetch = fakeFetch(() => ({ status: 401, body: { message: "invalid_client" } }));
    const err = await client(fetch)
      .revokeToken("ckr_x")
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect(err).not.toBeInstanceOf(TokenRevokedError);
    expect((err as ApiError).status).toBe(401);
  });

  it("refuses an empty token before any request", async () => {
    const fetch = fakeFetch(() => ({}));
    await expect(client(fetch).revokeToken("")).rejects.toThrow(/token is required/);
    expect(fetch.calls).toHaveLength(0);
  });
});

describe("toTokenSet", () => {
  it("drops scopes it does not recognise rather than failing", () => {
    const set = toTokenSet(
      { ...tokenBody({ scope: "location.verify.zone future.scope" }) } as never,
      1_000,
    );
    expect(set.scopes).toEqual(["location.verify.zone"]);
    expect(set.accessTokenExpiresAt).toBe(1_000 + 3600_000);
    expect(set.sub).toBeNull();
  });
});
