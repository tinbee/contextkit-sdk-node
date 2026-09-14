import { ScopeError, ScopeExpiredError, TokenRevokedError } from "./errors.js";
import { type HttpOptions, type HttpRequest, UnauthorizedSignal, request } from "./http.js";
import {
  type AppScope,
  type CreatedRule,
  type CreatedSubscription,
  type CurrentPlaceAnswer,
  type ConnectionEventName,
  type DaysWithData,
  type LatestPoint,
  type LocationSource,
  MAX_MAX_AGE_S,
  MAX_ZONE_RADIUS_M,
  MIN_MAX_AGE_S,
  MIN_ZONE_RADIUS_M,
  type Me,
  type MeResponse,
  PURPOSE_KEY_PATTERN,
  type PlaceLookup,
  type PointAt,
  type PointsPage,
  type PresenceAnswer,
  type RuleSummary,
  type RuleType,
  type SharedPlaceList,
  type SubscriptionSummary,
  type TokenSet,
  type VisitsPage,
  type ZoneAnswer,
  isAppScope,
} from "./types.js";

/** The minimum a caller must hold per user. A full TokenSet is accepted. */
export interface UserTokens {
  refreshToken: string;
  accessToken?: string;
  /** Epoch ms. Without it the first call refreshes. */
  accessTokenExpiresAt?: number;
  /** The effective scopes, as a TokenSet carries them. Used to pick the
   *  endpoint `rules.list()` may call; refreshed with every token set. */
  scopes?: readonly AppScope[];
}

export interface UserClientOptions {
  /**
   * Called every time tokens change (after a refresh). PERSIST THEM: refresh
   * tokens rotate, and the old one is dead the moment this fires. Awaited;
   * a throw here fails the call that triggered the refresh.
   */
  onTokens?: (tokens: TokenSet) => void | Promise<void>;
}

/** Refresh this many ms before expiry rather than racing the clock. */
const EXPIRY_SKEW_MS = 30_000;

export interface VerifyZoneParams {
  lat: number;
  lon: number;
  /** 100–10 000. Smaller zones are a triangulation tool, not a question. */
  radiusM: number;
  /** 3–80 chars; shown to the user in their access log. */
  label: string;
  /** How stale a fix may be and still count. 60–86 400, default 900. */
  maxAgeS?: number;
}

export interface DaysParams extends PurposeParams {
  from: string;
  to: string;
  /** IANA timezone the days are counted in. */
  tz: string;
}

export interface PointAtParams extends PurposeParams {
  at: string;
  toleranceS?: number;
  source?: LocationSource;
}

export interface VisitsListParams {
  from?: string;
  to?: string;
  /** 1–500 */
  limit?: number;
  cursor?: string;
}

/**
 * Every read of raw coordinates names the purpose it is for: the key of a
 * purpose registered (and, in production, approved) in the developer portal.
 * The user sees that purpose on consent, in their access log and on renewal.
 */
export interface PurposeParams {
  /** A registered purpose key, `^[a-z][a-z0-9_]{2,39}$`. */
  purpose: string;
}

export interface RangeParams extends PurposeParams {
  /** At most 31 days apart; page by month for longer histories. */
  from: string;
  to: string;
  deviceId?: string;
  source?: LocationSource;
  /** 1–5000 */
  limit?: number;
  cursor?: string;
  /**
   * At most one point per this many seconds (0–3600). The API's default is
   * 300; pass 0 to ask for every fix, which is deliberately explicit.
   */
  minIntervalS?: number;
}

interface BaseRuleParams {
  type: RuleType;
  /** 5–720; only for `dwell`. */
  dwellMinutes?: number;
  /** 30–3600; deliveries older than this are abandoned, not retried. */
  maxEventAgeS?: number;
  /**
   * The window the rule is evaluated in (ISO 8601 or Date). Either end is
   * optional; omit both for a standing rule. A rule counts against the
   * per-connection cap of ten only while its window is open, so a trip's
   * worth of one-day windows fits where ten standing rules would not.
   */
  activeFrom?: string | Date;
  activeUntil?: string | Date;
  /**
   * Omit it to deliver to your app's webhook endpoints subscribed to
   * `rule.fired` (register them in the developer portal) — the usual choice.
   * If given, it must exactly equal one of those registered endpoint URLs,
   * or the API answers 400 `webhook_url_not_registered`.
   */
  webhookUrl?: string;
}

export interface CreatePlaceRuleParams extends BaseRuleParams {
  placeId: string;
}

export interface CreateZoneRuleParams extends BaseRuleParams {
  lat: number;
  lon: number;
  radiusM: number;
  label: string;
}

/** What the app-level client lends a per-user handle. */
export interface UserClientBackend {
  refresh: (refreshToken: string) => Promise<TokenSet>;
  revoke: (token: string) => Promise<void>;
}

/**
 * All calls for one connected user. Handles access-token refresh: refreshes
 * before expiry, retries once on 401, and raises TokenRevokedError when a
 * refresh fails — at which point the user must reconnect.
 */
export class UserClient {
  private tokens: UserTokens;
  private refreshing: Promise<TokenSet> | null = null;
  private disconnected = false;

  constructor(
    private readonly http: HttpOptions,
    private readonly apiBaseUrl: string,
    private readonly backend: UserClientBackend,
    tokens: UserTokens,
    private readonly options: UserClientOptions,
  ) {
    if (!tokens.refreshToken) throw new Error("forUser: refreshToken is required");
    this.tokens = { ...tokens };
  }

  /** The tokens this client currently holds. */
  currentTokens(): Readonly<UserTokens> {
    return this.tokens;
  }

  /**
   * End this user's connection: the user pressed "disconnect" in your
   * product. Revokes the whole grant on ContextKit — every token, every
   * rule — and then refuses further calls on this handle with
   * TokenRevokedError, without a network round trip. Drop the stored tokens
   * once it resolves; to connect again the user goes through consent.
   * Safe to call twice.
   */
  async disconnect(): Promise<void> {
    if (this.disconnected) return;
    // Wait for any refresh in flight: the token it is about to hand back is
    // the one that must be revoked, and the one we hold is about to be spent.
    if (this.refreshing) await this.refreshing.catch(() => undefined);
    await this.backend.revoke(this.tokens.refreshToken);
    this.disconnected = true;
  }

  /**
   * Who this connection is: the pairwise `sub`, your `externalUserId`, the
   * scopes usable now versus held, and the two-tier expiry timestamps.
   * Any live token may call it, whatever its scopes.
   */
  async me(): Promise<Me> {
    const raw = await this.call<MeResponse>({ method: "GET", url: "/v1/me" });
    return toMe(raw);
  }

  readonly answers = {
    /** Is the user inside this circle right now? "unknown" is a value. */
    verifyZone: async (params: VerifyZoneParams): Promise<ZoneAnswer> => {
      assertRange("radiusM", params.radiusM, MIN_ZONE_RADIUS_M, MAX_ZONE_RADIUS_M);
      if (params.maxAgeS !== undefined)
        assertRange("maxAgeS", params.maxAgeS, MIN_MAX_AGE_S, MAX_MAX_AGE_S);
      return this.call<ZoneAnswer>({
        method: "POST",
        url: "/v1/answers/verify-zone",
        body: {
          lat: params.lat,
          lon: params.lon,
          radius_m: params.radiusM,
          label: params.label,
          ...(params.maxAgeS !== undefined ? { max_age_s: params.maxAgeS } : {}),
        },
      });
    },

    /** Which of the places shared with this app is the user at, if any? */
    currentPlace: (params: { maxAgeS?: number } = {}): Promise<CurrentPlaceAnswer> =>
      this.call<CurrentPlaceAnswer>({
        method: "GET",
        url: "/v1/answers/current-place",
        query: { max_age_s: params.maxAgeS },
      }),

    /** The places the user chose to share with this app. Cache by `version`. */
    places: (): Promise<SharedPlaceList> =>
      this.call<SharedPlaceList>({ method: "GET", url: "/v1/answers/places" }),

    /** Is the user at this shared place right now? */
    presence: (placeId: string, params: { maxAgeS?: number } = {}): Promise<PresenceAnswer> =>
      this.call<PresenceAnswer>({
        method: "GET",
        url: `/v1/answers/places/${encodeURIComponent(placeId)}/presence`,
        query: { max_age_s: params.maxAgeS },
      }),
  };

  readonly visits = {
    /** Stays at shared places, newest first. Follow `nextCursor`. */
    list: (params: VisitsListParams = {}): Promise<VisitsPage> =>
      this.call<VisitsPage>({
        method: "GET",
        url: "/v1/visits",
        query: { from: params.from, to: params.to, limit: params.limit, cursor: params.cursor },
      }),

    /** Which shared place was the user at, at this instant? */
    lookupPlace: (params: { at: string; toleranceS?: number }): Promise<PlaceLookup> =>
      this.call<PlaceLookup>({
        method: "GET",
        url: "/v1/lookup/place",
        query: { at: params.at, tolerance_s: params.toleranceS },
      }),
  };

  /**
   * Sensitive tier: raw coordinates. Needs the location.*.read / lookup
   * scopes, and every call names a registered `purpose`. When the sensitive
   * tier has lapsed these raise ScopeExpiredError; renew through consent.
   */
  readonly locations = {
    range: async (params: RangeParams): Promise<PointsPage> =>
      this.call<PointsPage>({
        method: "GET",
        url: "/v1/locations/timerange",
        query: {
          purpose: assertPurpose(params),
          from: params.from,
          to: params.to,
          device_id: params.deviceId,
          source: params.source,
          limit: params.limit,
          cursor: params.cursor,
          min_interval_s: params.minIntervalS,
        },
      }),

    /** Which calendar days (in `tz`) have any points. */
    days: async (params: DaysParams): Promise<DaysWithData> =>
      this.call<DaysWithData>({
        method: "GET",
        url: "/v1/locations/days",
        query: {
          purpose: assertPurpose(params),
          from: params.from,
          to: params.to,
          tz: params.tz,
        },
      }),

    latest: async (params: PurposeParams): Promise<LatestPoint> =>
      this.call<LatestPoint>({
        method: "GET",
        url: "/v1/locations/latest",
        query: { purpose: assertPurpose(params) },
      }),

    /** The point nearest `at`, within `toleranceS`. 404 if none. */
    at: async (params: PointAtParams): Promise<PointAt> =>
      this.call<PointAt>({
        method: "GET",
        url: "/v1/locations/lookup",
        query: {
          purpose: assertPurpose(params),
          at: params.at,
          tolerance_s: params.toleranceS,
          source: params.source,
        },
      }),
  };

  readonly rules = {
    /** Fire a webhook when the user enters / exits / dwells at a shared place.
     *  Deliveries are signed with your app webhook endpoint's secret. */
    createPlace: (params: CreatePlaceRuleParams): Promise<CreatedRule> =>
      this.call<CreatedRule>({
        method: "POST",
        url: "/v1/rules/place",
        body: { place_id: params.placeId, ...ruleBody(params) },
      }),

    createZone: async (params: CreateZoneRuleParams): Promise<CreatedRule> => {
      assertRange("radiusM", params.radiusM, MIN_ZONE_RADIUS_M, MAX_ZONE_RADIUS_M);
      return this.call<CreatedRule>({
        method: "POST",
        url: "/v1/rules/zone",
        body: {
          lat: params.lat,
          lon: params.lon,
          radius_m: params.radiusM,
          label: params.label,
          ...ruleBody(params),
        },
      });
    },

    /**
     * Every rule this app holds for the user, place and zone alike. Both list
     * endpoints return the same set but each demands its own scope, so this
     * asks the one the grant holds: zone when it holds only
     * location.rules.zone, place otherwise.
     */
    list: async (): Promise<RuleSummary[]> => {
      // Ensure a token set (and so the scopes) before choosing. A handle
      // ended by disconnect() must not refresh; call() refuses it below.
      if (!this.disconnected) await this.accessToken();
      const scopes = this.tokens.scopes;
      if (scopes) {
        const zoneOnly =
          scopes.includes("location.rules.zone") && !scopes.includes("location.rules.place");
        return this.call<RuleSummary[]>({
          method: "GET",
          url: zoneOnly ? "/v1/rules/zone" : "/v1/rules/place",
        });
      }
      // Scopes unknown (tokens persisted without them): try place, and fall
      // back to zone only when the grant plainly lacks the place scope.
      try {
        return await this.call<RuleSummary[]>({ method: "GET", url: "/v1/rules/place" });
      } catch (err) {
        if (!(err instanceof ScopeError) || err instanceof ScopeExpiredError) throw err;
        return this.call<RuleSummary[]>({ method: "GET", url: "/v1/rules/zone" });
      }
    },

    deletePlace: (ruleId: string): Promise<void> =>
      this.call<void>({ method: "DELETE", url: `/v1/rules/place/${encodeURIComponent(ruleId)}` }),

    deleteZone: (ruleId: string): Promise<void> =>
      this.call<void>({ method: "DELETE", url: `/v1/rules/zone/${encodeURIComponent(ruleId)}` }),
  };

  /**
   * @deprecated Connection events (`places.changed`, `sensitive.*`) are now
   * delivered for every connection to your app's webhook endpoints, registered
   * once in the developer portal. These routes keep working this release.
   */
  readonly subscriptions = {
    /** @deprecated Register an app webhook endpoint in the developer portal
     *  instead. One subscription per grant; registering again replaces it and
     *  mints a new secret. */
    register: (params: {
      events: readonly ConnectionEventName[];
      webhookUrl: string;
    }): Promise<CreatedSubscription> =>
      this.call<CreatedSubscription>({
        method: "POST",
        url: "/v1/subscriptions",
        body: { events: [...params.events], webhook_url: params.webhookUrl },
      }),

    /** @deprecated See `subscriptions`. */
    get: (): Promise<SubscriptionSummary | null> =>
      this.call<SubscriptionSummary | null>({ method: "GET", url: "/v1/subscriptions" }),

    /** @deprecated See `subscriptions`. */
    remove: (subscriptionId: string): Promise<void> =>
      this.call<void>({
        method: "DELETE",
        url: `/v1/subscriptions/${encodeURIComponent(subscriptionId)}`,
      }),
  };

  // -------------------------------------------------------------------------

  private async call<T>(req: Omit<HttpRequest, "headers">): Promise<T> {
    if (this.disconnected) {
      throw new TokenRevokedError(
        "this connection was ended by disconnect(); the user must reconnect",
      );
    }
    let accessToken = await this.accessToken();
    try {
      return await this.send<T>(req, accessToken);
    } catch (err) {
      if (!(err instanceof UnauthorizedSignal)) throw err;
    }
    // One retry after a forced refresh; a second 401 means the grant is gone.
    accessToken = (await this.refresh()).accessToken;
    try {
      return await this.send<T>(req, accessToken);
    } catch (err) {
      if (err instanceof UnauthorizedSignal) throw new TokenRevokedError(undefined, err.body);
      throw err;
    }
  }

  private async send<T>(req: Omit<HttpRequest, "headers">, accessToken: string): Promise<T> {
    const res = await request<T>(this.http, {
      ...req,
      url: `${this.apiBaseUrl}${req.url}`,
      headers: { authorization: `Bearer ${accessToken}` },
    });
    return res.data;
  }

  private async accessToken(): Promise<string> {
    const { accessToken, accessTokenExpiresAt } = this.tokens;
    if (accessToken && accessTokenExpiresAt && accessTokenExpiresAt - EXPIRY_SKEW_MS > Date.now()) {
      return accessToken;
    }
    return (await this.refresh()).accessToken;
  }

  /** Single-flight: concurrent calls share one refresh, because the second
   *  use of a rotated refresh token is treated as replay and kills the grant. */
  private refresh(): Promise<TokenSet> {
    if (!this.refreshing) {
      this.refreshing = this.backend
        .refresh(this.tokens.refreshToken)
        .then(async (next) => {
          this.tokens = {
            refreshToken: next.refreshToken,
            accessToken: next.accessToken,
            accessTokenExpiresAt: next.accessTokenExpiresAt,
            scopes: next.scopes,
          };
          if (this.options.onTokens) await this.options.onTokens(next);
          return next;
        })
        .finally(() => {
          this.refreshing = null;
        });
    }
    return this.refreshing;
  }
}

/** Refuses a missing or malformed purpose before any request: the API would
 *  answer 400 `invalid_purpose`, and the check is cheaper here. */
function assertPurpose(params: PurposeParams | undefined): string {
  const purpose = (params as { purpose?: unknown } | undefined)?.purpose;
  if (typeof purpose !== "string" || purpose.length === 0) {
    throw new TypeError(
      "purpose is required: pass the key of a purpose registered for this app in the developer portal",
    );
  }
  if (!PURPOSE_KEY_PATTERN.test(purpose)) {
    throw new TypeError(
      `purpose "${purpose}" is not a purpose key (lowercase letter, then 2–39 of a-z, 0-9, _)`,
    );
  }
  return purpose;
}

function toMe(raw: MeResponse): Me {
  const scopes = (raw.scopes ?? []).filter(isAppScope);
  return {
    sub: raw.sub,
    externalUserId: raw.external_user_id ?? null,
    scopes,
    heldScopes: raw.held_scopes ? raw.held_scopes.filter(isAppScope) : scopes,
    placesVersion: raw.places_version ?? null,
    expiresAt: raw.expires_at ?? raw.grant_expires_at ?? null,
    sensitiveExpiresAt: raw.sensitive_expires_at ?? null,
    sensitiveLapsedAt: raw.sensitive_lapsed_at ?? null,
    renewalGraceEndsAt: raw.renewal_grace_ends_at ?? null,
    connectedAt: raw.connected_at ?? null,
  };
}

function ruleBody(params: BaseRuleParams): Record<string, unknown> {
  return {
    type: params.type,
    ...(params.webhookUrl !== undefined ? { webhook_url: params.webhookUrl } : {}),
    ...(params.dwellMinutes !== undefined ? { dwell_minutes: params.dwellMinutes } : {}),
    ...(params.maxEventAgeS !== undefined ? { max_event_age_s: params.maxEventAgeS } : {}),
    ...(params.activeFrom !== undefined
      ? { active_from: isoString("activeFrom", params.activeFrom) }
      : {}),
    ...(params.activeUntil !== undefined
      ? { active_until: isoString("activeUntil", params.activeUntil) }
      : {}),
  };
}

function assertRange(name: string, value: number, min: number, max: number): void {
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new RangeError(`${name} must be an integer between ${min} and ${max}, got ${value}`);
  }
}

/** A Date that is not a date (`new Date(NaN)`) fails here with its name,
 *  not as a RangeError from deep inside toISOString. Strings pass through:
 *  the API validates them and answers with a 400 that names the field. */
function isoString(name: string, value: string | Date): string {
  if (!(value instanceof Date)) return value;
  if (Number.isNaN(value.getTime())) throw new Error(`${name}: invalid Date`);
  return value.toISOString();
}
