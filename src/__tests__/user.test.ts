import { ContextKit } from "../client.js";
import {
  NotFoundError,
  RateLimitedError,
  ScopeError,
  TimeoutError,
  TokenRevokedError,
} from "../errors.js";
import type { TokenSet } from "../types.js";
import { type Captured, fakeFetch, tokenBody } from "./fake-fetch.js";

const CLIENT_ID = "11111111-1111-4111-8111-111111111111";

function isToken(req: Captured): boolean {
  return req.url.endsWith("/v1/oauth/token");
}

function make(handler: Parameters<typeof fakeFetch>[0], timeoutMs = 10_000) {
  const fetch = fakeFetch(handler);
  const ck = new ContextKit({
    clientId: CLIENT_ID,
    clientSecret: "shh",
    apiBaseUrl: "https://api.test",
    fetch,
    timeoutMs,
  });
  return { ck, fetch };
}

const fresh = {
  refreshToken: "rt-0",
  accessToken: "at-0",
  accessTokenExpiresAt: Date.now() + 3600_000,
};

describe("UserClient answers", () => {
  it("verifyZone sends snake_case and returns 'unknown' as a value", async () => {
    const { ck, fetch } = make(() => ({
      body: {
        state: "unknown",
        reason: "stale",
        asOf: "2026-09-12T10:00:00.000Z",
        ageSeconds: 1200,
      },
    }));
    const answer = await ck.forUser(fresh).answers.verifyZone({
      lat: 48.35,
      lon: 11.78,
      radiusM: 500,
      label: "MUC arrivals",
      maxAgeS: 600,
    });
    expect(answer.state).toBe("unknown");
    expect(answer.reason).toBe("stale");
    const req = fetch.calls[0]!;
    expect(req.url).toBe("https://api.test/v1/answers/verify-zone");
    expect(req.headers["authorization"]).toBe("Bearer at-0");
    expect(req.body).toEqual({
      lat: 48.35,
      lon: 11.78,
      radius_m: 500,
      label: "MUC arrivals",
      max_age_s: 600,
    });
  });

  it("rejects a radius the API would reject, before any request", async () => {
    const { ck, fetch } = make(() => ({}));
    await expect(
      ck.forUser(fresh).answers.verifyZone({ lat: 0, lon: 0, radiusM: 50, label: "tiny" }),
    ).rejects.toBeInstanceOf(RangeError);
    expect(fetch.calls).toHaveLength(0);
  });

  it("presence encodes the place id and passes max_age_s as a query param", async () => {
    const { ck, fetch } = make(() => ({
      body: { state: "yes", reason: null, asOf: null, ageSeconds: 5 },
    }));
    await ck.forUser(fresh).answers.presence("place/1", { maxAgeS: 120 });
    expect(fetch.calls[0]?.url).toBe(
      "https://api.test/v1/answers/places/place%2F1/presence?max_age_s=120",
    );
  });

  it("omits undefined query params entirely", async () => {
    const { ck, fetch } = make(() => ({ body: { visits: [], nextCursor: null } }));
    await ck.forUser(fresh).visits.list({ limit: 10 });
    expect(fetch.calls[0]?.url).toBe("https://api.test/v1/visits?limit=10");
  });
});

describe("UserClient token lifecycle", () => {
  it("refreshes first when it holds no access token, and hands the new set to onTokens", async () => {
    const { ck, fetch } = make((req) =>
      isToken(req)
        ? { body: tokenBody({ access_token: "at-1", refresh_token: "rt-1" }) }
        : { body: { version: 1, places: [] } },
    );
    const seen: TokenSet[] = [];
    const user = ck.forUser({ refreshToken: "rt-0" }, { onTokens: (t) => void seen.push(t) });
    await user.answers.places();
    expect(fetch.calls.map((c) => c.url)).toEqual([
      "https://api.test/v1/oauth/token",
      "https://api.test/v1/answers/places",
    ]);
    expect(fetch.calls[0]?.body).toEqual({
      clientId: CLIENT_ID,
      clientSecret: "shh",
      grantType: "refresh_token",
      refreshToken: "rt-0",
    });
    expect(fetch.calls[1]?.headers["authorization"]).toBe("Bearer at-1");
    expect(seen.map((t) => t.refreshToken)).toEqual(["rt-1"]);
    expect(user.currentTokens().refreshToken).toBe("rt-1");
  });

  it("retries once after a 401 with a refreshed token", async () => {
    const { ck, fetch } = make((req, i) => {
      if (isToken(req)) return { body: tokenBody({ access_token: "at-1", refresh_token: "rt-1" }) };
      return i === 0
        ? { status: 401, body: { statusCode: 401 } }
        : { body: { version: 2, places: [] } };
    });
    const result = await ck.forUser(fresh).answers.places();
    expect(result.version).toBe(2);
    expect(fetch.calls.map((c) => c.url.replace("https://api.test", ""))).toEqual([
      "/v1/answers/places",
      "/v1/oauth/token",
      "/v1/answers/places",
    ]);
  });

  it("raises TokenRevokedError when the refresh itself is refused", async () => {
    const { ck } = make((req) =>
      isToken(req)
        ? { status: 401, body: { statusCode: 401, message: "refresh token revoked" } }
        : { status: 401, body: {} },
    );
    await expect(ck.forUser(fresh).answers.places()).rejects.toBeInstanceOf(TokenRevokedError);
  });

  it("raises TokenRevokedError when a second 401 follows a successful refresh", async () => {
    const { ck } = make((req) =>
      isToken(req) ? { body: tokenBody() } : { status: 401, body: {} },
    );
    await expect(ck.forUser(fresh).answers.places()).rejects.toBeInstanceOf(TokenRevokedError);
  });

  it("shares one refresh across concurrent calls (rotated tokens must not be reused)", async () => {
    const { ck, fetch } = make((req) =>
      isToken(req)
        ? { body: tokenBody({ refresh_token: "rt-1" }) }
        : { body: { version: 1, places: [] } },
    );
    const user = ck.forUser({ refreshToken: "rt-0" });
    await Promise.all([user.answers.places(), user.answers.places(), user.answers.currentPlace()]);
    expect(fetch.calls.filter(isToken)).toHaveLength(1);
  });

  it("refreshes ahead of expiry rather than racing the clock", async () => {
    const { ck, fetch } = make((req) => (isToken(req) ? { body: tokenBody() } : { body: {} }));
    await ck
      .forUser({
        refreshToken: "rt-0",
        accessToken: "at-0",
        accessTokenExpiresAt: Date.now() + 5_000,
      })
      .answers.places();
    expect(fetch.calls[0] && isToken(fetch.calls[0])).toBe(true);
  });
});

describe("UserClient.disconnect", () => {
  it("revokes the refresh token it holds, then refuses further calls without a request", async () => {
    const { ck, fetch } = make(() => ({ status: 200 }));
    const user = ck.forUser(fresh);
    await user.disconnect();
    expect(fetch.calls.map((c) => c.url.replace("https://api.test", ""))).toEqual([
      "/v1/oauth/revoke",
    ]);
    expect(fetch.calls[0]?.body).toMatchObject({ token: "rt-0" });
    await expect(user.answers.places()).rejects.toBeInstanceOf(TokenRevokedError);
    expect(fetch.calls).toHaveLength(1);
  });

  it("is idempotent, and revokes the CURRENT refresh token after a rotation", async () => {
    const { ck, fetch } = make((req) =>
      isToken(req)
        ? { body: tokenBody({ refresh_token: "rt-1" }) }
        : req.url.endsWith("/v1/oauth/revoke")
          ? { status: 200 }
          : { body: { version: 1, places: [] } },
    );
    const user = ck.forUser({ refreshToken: "rt-0" });
    await user.answers.places(); // rotates rt-0 → rt-1
    await user.disconnect();
    await user.disconnect();
    const revokes = fetch.calls.filter((c) => c.url.endsWith("/v1/oauth/revoke"));
    expect(revokes).toHaveLength(1);
    expect(revokes[0]?.body).toMatchObject({ token: "rt-1" });
  });
});

describe("UserClient locations", () => {
  it("range sends min_interval_s and omits it when unset", async () => {
    const { ck, fetch } = make(() => ({ body: { points: [] } }));
    const user = ck.forUser(fresh);
    await user.locations.range({
      purpose: "trip_timeline",
      from: "2026-09-01T00:00:00Z",
      to: "2026-09-02T00:00:00Z",
      minIntervalS: 0,
    });
    expect(fetch.calls[0]?.url).toContain("min_interval_s=0");
    await user.locations.range({
      purpose: "trip_timeline",
      from: "2026-09-01T00:00:00Z",
      to: "2026-09-02T00:00:00Z",
    });
    expect(fetch.calls[1]?.url).not.toContain("min_interval_s");
  });
});

describe("UserClient error mapping", () => {
  it("429 → RateLimitedError with Retry-After", async () => {
    const { ck } = make(() => ({
      status: 429,
      headers: { "Retry-After": "37" },
      body: { message: "verify budget exhausted (hourly)" },
    }));
    const err = await ck
      .forUser(fresh)
      .answers.places()
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(RateLimitedError);
    expect((err as RateLimitedError).retryAfterSeconds).toBe(37);
    expect((err as RateLimitedError).message).toMatch(/hourly/);
  });

  it("403 → ScopeError, 404 → NotFoundError", async () => {
    const forbidden = make(() => ({ status: 403, body: { message: "missing scope" } }));
    await expect(forbidden.ck.forUser(fresh).answers.places()).rejects.toBeInstanceOf(ScopeError);
    const missing = make(() => ({ status: 404, body: { message: "place not found" } }));
    await expect(missing.ck.forUser(fresh).answers.presence("x")).rejects.toBeInstanceOf(
      NotFoundError,
    );
  });

  it("a hung upstream becomes TimeoutError, not a hang", async () => {
    const { ck } = make(() => ({ hang: true }), 20);
    await expect(ck.forUser(fresh).answers.places()).rejects.toBeInstanceOf(TimeoutError);
  });
});

describe("UserClient rules + subscriptions", () => {
  it("createZone maps camelCase to the wire and returns the one-time secret", async () => {
    const { ck, fetch } = make(() => ({ body: { id: "r1", secret: "s1" } }));
    const rule = await ck.forUser(fresh).rules.createZone({
      type: "dwell",
      lat: 1,
      lon: 2,
      radiusM: 300,
      label: "Hotel",
      dwellMinutes: 15,
      maxEventAgeS: 120,
      webhookUrl: "https://paperowl.test/hooks/ck",
    });
    expect(rule.secret).toBe("s1");
    expect(fetch.calls[0]?.body).toEqual({
      lat: 1,
      lon: 2,
      radius_m: 300,
      label: "Hotel",
      type: "dwell",
      webhook_url: "https://paperowl.test/hooks/ck",
      dwell_minutes: 15,
      max_event_age_s: 120,
    });
  });

  it("createZone sends an active window as ISO strings, from strings or Dates", async () => {
    const { ck, fetch } = make(() => ({ body: { id: "r1", secret: "s1" } }));
    await ck.forUser(fresh).rules.createZone({
      type: "enter",
      lat: 41.9,
      lon: 12.5,
      radiusM: 300,
      label: "Hotel Artemide",
      activeFrom: new Date("2026-09-19T12:00:00Z"),
      activeUntil: "2026-09-21T00:00:00.000Z",
      webhookUrl: "https://paperowl.test/hooks/ck",
    });
    expect(fetch.calls[0]?.body).toMatchObject({
      active_from: "2026-09-19T12:00:00.000Z",
      active_until: "2026-09-21T00:00:00.000Z",
    });
    expect(fetch.calls[0]?.body).not.toHaveProperty("dwell_minutes");
  });

  it("createPlace serializes the window the same way", async () => {
    const { ck, fetch } = make(() => ({ body: { id: "r2", secret: "s2" } }));
    await ck.forUser(fresh).rules.createPlace({
      type: "enter",
      placeId: "p1",
      activeFrom: "2026-09-19T12:00:00Z",
      activeUntil: new Date("2026-09-21T00:00:00Z"),
      webhookUrl: "https://paperowl.test/hooks/ck",
    });
    expect(fetch.calls[0]?.body).toEqual({
      place_id: "p1",
      type: "enter",
      webhook_url: "https://paperowl.test/hooks/ck",
      active_from: "2026-09-19T12:00:00Z",
      active_until: "2026-09-21T00:00:00.000Z",
    });
  });

  it("names the field when handed a Date that is not a date", async () => {
    const { ck, fetch } = make(() => ({}));
    await expect(
      ck.forUser(fresh).rules.createZone({
        type: "enter",
        lat: 1,
        lon: 2,
        radiusM: 300,
        label: "Hotel",
        activeUntil: new Date(NaN),
        webhookUrl: "https://paperowl.test/hooks/ck",
      }),
    ).rejects.toThrow(/activeUntil: invalid Date/);
    expect(fetch.calls).toHaveLength(0);
  });

  it("register posts events + webhook_url", async () => {
    const { ck, fetch } = make(() => ({ body: { id: "sub1", secret: "s" } }));
    await ck
      .forUser(fresh)
      .subscriptions.register({ events: ["places.changed"], webhookUrl: "https://x/h" });
    expect(fetch.calls[0]?.body).toEqual({
      events: ["places.changed"],
      webhook_url: "https://x/h",
    });
  });
});
