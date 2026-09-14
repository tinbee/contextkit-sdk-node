import { ContextKit, toTokenSet } from "../client.js";
import { ScopeError, ScopeExpiredError, ValidationError, isMissingScope } from "../errors.js";
import {
  CONNECTION_EVENTS,
  type SensitiveExpiringEvent,
  type WebhookEvent,
  isConnectionEvent,
  isPlacesChangedEvent,
  isPurposeKey,
  isRuleEvent,
  isSensitiveExpiringEvent,
  isSensitiveLapsedEvent,
  isSensitiveRemovedEvent,
} from "../types.js";
import { signWebhook, verifyWebhook } from "../webhooks.js";
import { type Captured, fakeFetch, tokenBody } from "./fake-fetch.js";

const CLIENT_ID = "11111111-1111-4111-8111-111111111111";

function isToken(req: Captured): boolean {
  return req.url.endsWith("/v1/oauth/token");
}

function make(handler: Parameters<typeof fakeFetch>[0]) {
  const fetch = fakeFetch(handler);
  const ck = new ContextKit({
    clientId: CLIENT_ID,
    clientSecret: "shh",
    apiBaseUrl: "https://api.test",
    fetch,
  });
  return { ck, fetch };
}

const fresh = {
  refreshToken: "rt-0",
  accessToken: "at-0",
  accessTokenExpiresAt: Date.now() + 3600_000,
};

function path(req: Captured | undefined): string {
  return (req?.url ?? "").replace("https://api.test", "");
}

describe("TokenSet.sensitiveScopesExpiresAt", () => {
  it("maps sensitive_scopes_expire_at to epoch ms", () => {
    const set = toTokenSet(
      tokenBody({ sensitive_scopes_expire_at: "2026-10-13T00:00:00.000Z" }) as never,
      1_000,
    );
    expect(set.sensitiveScopesExpiresAt).toBe(Date.parse("2026-10-13T00:00:00.000Z"));
  });

  it("is null when the field is absent, null, or not a date", () => {
    expect(toTokenSet(tokenBody() as never).sensitiveScopesExpiresAt).toBeNull();
    expect(
      toTokenSet(tokenBody({ sensitive_scopes_expire_at: null }) as never).sensitiveScopesExpiresAt,
    ).toBeNull();
    expect(
      toTokenSet(tokenBody({ sensitive_scopes_expire_at: "soon" }) as never)
        .sensitiveScopesExpiresAt,
    ).toBeNull();
  });

  it("reaches onTokens after a refresh", async () => {
    const { ck } = make((req) =>
      isToken(req)
        ? { body: tokenBody({ sensitive_scopes_expire_at: "2026-10-13T00:00:00.000Z" }) }
        : { body: { version: 1, places: [] } },
    );
    const seen: (number | null)[] = [];
    await ck
      .forUser(
        { refreshToken: "rt-0" },
        { onTokens: (t) => void seen.push(t.sensitiveScopesExpiresAt) },
      )
      .answers.places();
    expect(seen).toEqual([Date.parse("2026-10-13T00:00:00.000Z")]);
  });
});

describe("error mapping for the two tiers", () => {
  it("403 scope_expired → ScopeExpiredError (still a ScopeError) with both timestamps", async () => {
    const { ck } = make(() => ({
      status: 403,
      body: {
        statusCode: 403,
        error: "scope_expired",
        message: "sensitive access to location.latest.read has expired",
        sensitive_expired_at: "2026-09-01T00:00:00.000Z",
        renewal_grace_ends_at: "2026-09-15T00:00:00.000Z",
      },
    }));
    const err = await ck
      .forUser(fresh)
      .locations.latest({ purpose: "arrival_check" })
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ScopeExpiredError);
    expect(err).toBeInstanceOf(ScopeError);
    const e = err as ScopeExpiredError;
    expect(e.name).toBe("ScopeExpiredError");
    expect(e.code).toBe("scope_expired");
    expect(e.status).toBe(403);
    expect(e.sensitiveExpiredAt).toBe("2026-09-01T00:00:00.000Z");
    expect(e.renewalGraceEndsAt).toBe("2026-09-15T00:00:00.000Z");
    expect(e.message).toMatch(/expired/);
  });

  it("403 missing_scope stays a plain ScopeError", async () => {
    const { ck } = make(() => ({
      status: 403,
      body: { statusCode: 403, error: "missing_scope", message: "grant is missing scope x" },
    }));
    const err = await ck
      .forUser(fresh)
      .answers.places()
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ScopeError);
    expect(err).not.toBeInstanceOf(ScopeExpiredError);
    expect((err as ScopeError).code).toBe("scope");
  });

  it("400 invalid_purpose → ValidationError carrying error + detail", async () => {
    const { ck } = make(() => ({
      status: 400,
      body: {
        statusCode: 400,
        error: "invalid_purpose",
        detail: "purpose arrival_check is not approved for location.history.read",
      },
    }));
    const err = await ck
      .forUser(fresh)
      .locations.range({ purpose: "arrival_check", from: "a", to: "b" })
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ValidationError);
    const e = err as ValidationError;
    expect(e.error).toBe("invalid_purpose");
    expect(e.detail).toMatch(/not approved/);
    expect(e.message).toMatch(/not approved/);
    expect(e.messages).toEqual([]);
  });

  it("a plain Nest 400 still reads as before", async () => {
    const { ck } = make(() => ({
      status: 400,
      body: { statusCode: 400, message: ["from must be ISO 8601"], error: "Bad Request" },
    }));
    const err = (await ck
      .forUser(fresh)
      .locations.days({ purpose: "trip_days", from: "x", to: "y", tz: "UTC" })
      .catch((e: unknown) => e)) as ValidationError;
    expect(err).toBeInstanceOf(ValidationError);
    expect(err.messages).toEqual(["from must be ISO 8601"]);
    expect(err.detail).toBeNull();
  });
});

describe("purpose on location reads", () => {
  const ok = () => ({ body: {} });

  it("sends purpose as a query param on latest, at, range and days", async () => {
    const { ck, fetch } = make(ok);
    const user = ck.forUser(fresh);
    await user.locations.latest({ purpose: "arrival_check" });
    await user.locations.at({ purpose: "trip_lookup", at: "2026-09-01T10:00:00Z" });
    await user.locations.range({ purpose: "trip_timeline", from: "a", to: "b" });
    await user.locations.days({ purpose: "trip_days", from: "a", to: "b", tz: "Europe/Rome" });
    const urls = fetch.calls.map((c) => new URL(c.url));
    expect(urls.map((u) => u.pathname)).toEqual([
      "/v1/locations/latest",
      "/v1/locations/lookup",
      "/v1/locations/timerange",
      "/v1/locations/days",
    ]);
    expect(urls.map((u) => u.searchParams.get("purpose"))).toEqual([
      "arrival_check",
      "trip_lookup",
      "trip_timeline",
      "trip_days",
    ]);
  });

  it("refuses a missing purpose before any request", async () => {
    const { ck, fetch } = make(ok);
    const user = ck.forUser(fresh);
    const loose = user.locations as unknown as Record<string, (p?: unknown) => Promise<unknown>>;
    await expect(loose.latest!()).rejects.toThrow(/purpose is required/);
    await expect(loose.latest!({})).rejects.toThrow(/purpose is required/);
    await expect(loose.at!({ at: "x" })).rejects.toThrow(/purpose is required/);
    await expect(loose.range!({ from: "a", to: "b" })).rejects.toThrow(/purpose is required/);
    await expect(loose.days!({ from: "a", to: "b", tz: "UTC", purpose: "" })).rejects.toThrow(
      /purpose is required/,
    );
    expect(fetch.calls).toHaveLength(0);
  });

  it("refuses a purpose that is not a key", async () => {
    const { ck, fetch } = make(ok);
    const user = ck.forUser(fresh);
    for (const bad of ["Arrival", "ab", "1abc", "has-dash", "has space", "a".repeat(41)]) {
      await expect(user.locations.latest({ purpose: bad })).rejects.toBeInstanceOf(TypeError);
    }
    expect(fetch.calls).toHaveLength(0);
  });

  it("isPurposeKey matches the portal's pattern at both length bounds", () => {
    expect(isPurposeKey("abc")).toBe(true);
    expect(isPurposeKey("a" + "b".repeat(39))).toBe(true);
    expect(isPurposeKey("a" + "b".repeat(40))).toBe(false);
    expect(isPurposeKey("a_1")).toBe(true);
    expect(isPurposeKey(42)).toBe(false);
  });
});

describe("UserClient.me", () => {
  it("returns the two-tier /v1/me body in camelCase", async () => {
    const { ck, fetch } = make(() => ({
      body: {
        sub: "sub-1",
        external_user_id: "u-42",
        scopes: ["location.verify.zone"],
        held_scopes: ["location.verify.zone", "location.latest.read", "future.scope"],
        places_version: 3,
        grant_expires_at: null,
        sensitive_expires_at: "2026-09-01T00:00:00.000Z",
        sensitive_lapsed_at: "2026-09-01T00:10:00.000Z",
        renewal_grace_ends_at: "2026-09-15T00:00:00.000Z",
        connected_at: "2026-06-01T00:00:00.000Z",
      },
    }));
    const me = await ck.forUser(fresh).me();
    expect(path(fetch.calls[0])).toBe("/v1/me");
    expect(fetch.calls[0]?.method).toBe("GET");
    expect(me).toEqual({
      sub: "sub-1",
      externalUserId: "u-42",
      scopes: ["location.verify.zone"],
      heldScopes: ["location.verify.zone", "location.latest.read"],
      placesVersion: 3,
      expiresAt: null,
      sensitiveExpiresAt: "2026-09-01T00:00:00.000Z",
      sensitiveLapsedAt: "2026-09-01T00:10:00.000Z",
      renewalGraceEndsAt: "2026-09-15T00:00:00.000Z",
      connectedAt: "2026-06-01T00:00:00.000Z",
    });
  });

  it("accepts expires_at and fills absent tier fields with null", async () => {
    const { ck } = make(() => ({
      body: {
        sub: "sub-1",
        external_user_id: null,
        scopes: ["location.rules.zone"],
        expires_at: "2027-01-01T00:00:00.000Z",
        connected_at: null,
      },
    }));
    const me = await ck.forUser(fresh).me();
    expect(me.expiresAt).toBe("2027-01-01T00:00:00.000Z");
    expect(me.heldScopes).toEqual(["location.rules.zone"]);
    expect(me.sensitiveExpiresAt).toBeNull();
    expect(me.sensitiveLapsedAt).toBeNull();
    expect(me.renewalGraceEndsAt).toBeNull();
    expect(me.placesVersion).toBeNull();
  });
});

describe("rules.list endpoint choice", () => {
  const withScopes = (scopes: string[]) => ({ ...fresh, scopes: scopes as never });

  it("zone-only grant → /v1/rules/zone", async () => {
    const { ck, fetch } = make(() => ({ body: [] }));
    await ck.forUser(withScopes(["location.rules.zone", "location.verify.zone"])).rules.list();
    expect(fetch.calls.map(path)).toEqual(["/v1/rules/zone"]);
  });

  it("place-only grant → /v1/rules/place", async () => {
    const { ck, fetch } = make(() => ({ body: [] }));
    await ck.forUser(withScopes(["location.rules.place"])).rules.list();
    expect(fetch.calls.map(path)).toEqual(["/v1/rules/place"]);
  });

  it("both scopes → /v1/rules/place", async () => {
    const { ck, fetch } = make(() => ({ body: [] }));
    await ck.forUser(withScopes(["location.rules.zone", "location.rules.place"])).rules.list();
    expect(fetch.calls.map(path)).toEqual(["/v1/rules/place"]);
  });

  it("learns the scopes from the refresh when it holds no access token", async () => {
    const { ck, fetch } = make((req) =>
      isToken(req) ? { body: tokenBody({ scope: "location.rules.zone" }) } : { body: [] },
    );
    await ck.forUser({ refreshToken: "rt-0" }).rules.list();
    expect(fetch.calls.map(path)).toEqual(["/v1/oauth/token", "/v1/rules/zone"]);
  });

  it("with scopes unknown, falls back to zone only on a missing-scope 403", async () => {
    const { ck, fetch } = make((req) =>
      req.url.endsWith("/v1/rules/place")
        ? { status: 403, body: { error: "missing_scope", message: "missing scope" } }
        : { body: [{ id: "r1" }] },
    );
    const rules = await ck.forUser(fresh).rules.list();
    expect(rules).toEqual([{ id: "r1" }]);
    expect(fetch.calls.map(path)).toEqual(["/v1/rules/place", "/v1/rules/zone"]);
  });

  it("with scopes unknown, rethrows any other 403 instead of falling back", async () => {
    const { ck, fetch } = make((req) =>
      req.url.endsWith("/v1/rules/place")
        ? { status: 403, body: { error: "app_suspended", message: "app is suspended" } }
        : { body: [{ id: "r1" }] },
    );
    const err = await ck
      .forUser(fresh)
      .rules.list()
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ScopeError);
    expect(fetch.calls.map(path)).toEqual(["/v1/rules/place"]);
  });
});

describe("isMissingScope", () => {
  it("is true only for a missing-scope ScopeError", () => {
    expect(isMissingScope(new ScopeError("x", { error: "missing_scope" }))).toBe(true);
    expect(isMissingScope(new ScopeError("grant is missing scope y", {}))).toBe(true);
    expect(isMissingScope(new ScopeError("app is suspended", { error: "app_suspended" }))).toBe(
      false,
    );
    expect(isMissingScope(new Error("missing scope"))).toBe(false);
  });
});

describe("sensitive.* connection events", () => {
  const base = {
    event_id: "evt-1",
    subscription_id: "sub-1",
    grant_id: "g-1",
    occurred_at: new Date(1_800_000_000_000).toISOString(),
  };
  const expiring: WebhookEvent = {
    ...base,
    type: "sensitive.expiring",
    sensitive_expires_at: "2027-01-15T00:00:00.000Z",
    days_left: 14,
    scopes: ["location.latest.read"],
  };
  const lapsed: WebhookEvent = {
    ...base,
    type: "sensitive.lapsed",
    sensitive_expires_at: "2027-01-15T00:00:00.000Z",
    renewal_grace_ends_at: "2027-01-29T00:00:00.000Z",
    scopes: ["location.latest.read"],
  };
  const removed: WebhookEvent = { ...base, type: "sensitive.removed", scopes: ["location.lookup"] };
  const places: WebhookEvent = { ...base, type: "places.changed", places_version: 4 };
  const rule: WebhookEvent = {
    event_id: "evt-2",
    rule_id: "r-1",
    grant_id: "g-1",
    type: "zone.enter",
    occurred_at: base.occurred_at,
    target: { label: "Hotel" },
  };

  it("CONNECTION_EVENTS lists all four", () => {
    expect([...CONNECTION_EVENTS]).toEqual([
      "places.changed",
      "sensitive.expiring",
      "sensitive.lapsed",
      "sensitive.removed",
    ]);
  });

  it("each guard accepts exactly its own event", () => {
    const all = [expiring, lapsed, removed, places, rule];
    const truth = (guard: (e: WebhookEvent) => boolean) => all.map(guard);
    expect(truth(isSensitiveExpiringEvent)).toEqual([true, false, false, false, false]);
    expect(truth(isSensitiveLapsedEvent)).toEqual([false, true, false, false, false]);
    expect(truth(isSensitiveRemovedEvent)).toEqual([false, false, true, false, false]);
    expect(truth(isPlacesChangedEvent)).toEqual([false, false, false, true, false]);
    expect(truth(isConnectionEvent)).toEqual([true, true, true, true, false]);
    expect(truth(isRuleEvent)).toEqual([false, false, false, false, true]);
  });

  it("a verified delivery narrows to its typed body", async () => {
    const raw = JSON.stringify(expiring);
    const now = Date.parse(base.occurred_at);
    const event = await verifyWebhook({
      rawBody: raw,
      signature: signWebhook(raw, "whsec", now),
      secret: "whsec",
      now,
    });
    if (!isSensitiveExpiringEvent(event)) throw new Error("expected sensitive.expiring");
    const typed: SensitiveExpiringEvent = event;
    expect(typed.days_left).toBe(14);
    expect(typed.scopes).toEqual(["location.latest.read"]);
  });
});
