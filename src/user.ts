import { TokenRevokedError } from "./errors.js";
import { type HttpOptions, type HttpRequest, UnauthorizedSignal, request } from "./http.js";
import {
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
} from "./types.js";

/** The minimum a caller must hold per user. A full TokenSet is accepted. */
export interface UserTokens {
  refreshToken: string;
  accessToken?: string;
  /** Epoch ms. Without it the first call refreshes. */
  accessTokenExpiresAt?: number;
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

export interface VisitsListParams {
  from?: string;
  to?: string;
  /** 1–500 */
  limit?: number;
  cursor?: string;
}

export interface RangeParams {
  from: string;
  to: string;
  deviceId?: string;
  source?: LocationSource;
  /** 1–5000 */
  limit?: number;
  cursor?: string;
}

interface BaseRuleParams {
  type: RuleType;
  /** 5–720; only for `dwell`. */
  dwellMinutes?: number;
  /** 30–3600; deliveries older than this are abandoned, not retried. */
  maxEventAgeS?: number;
  /** https only. */
  webhookUrl: string;
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

/**
 * All calls for one connected user. Handles access-token refresh: refreshes
 * before expiry, retries once on 401, and raises TokenRevokedError when a
 * refresh fails — at which point the user must reconnect.
 */
export class UserClient {
  private tokens: UserTokens;
  private refreshing: Promise<TokenSet> | null = null;

  constructor(
    private readonly http: HttpOptions,
    private readonly apiBaseUrl: string,
    private readonly refreshImpl: (refreshToken: string) => Promise<TokenSet>,
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

  /** Sensitive tier: raw coordinates. Needs the location.*.read / lookup scopes. */
  readonly locations = {
    range: (params: RangeParams): Promise<PointsPage> =>
      this.call<PointsPage>({
        method: "GET",
        url: "/v1/locations/timerange",
        query: {
          from: params.from,
          to: params.to,
          device_id: params.deviceId,
          source: params.source,
          limit: params.limit,
          cursor: params.cursor,
        },
      }),

    /** Which calendar days (in `tz`) have any points. */
    days: (params: { from: string; to: string; tz: string }): Promise<DaysWithData> =>
      this.call<DaysWithData>({
        method: "GET",
        url: "/v1/locations/days",
        query: { from: params.from, to: params.to, tz: params.tz },
      }),

    latest: (): Promise<LatestPoint> =>
      this.call<LatestPoint>({ method: "GET", url: "/v1/locations/latest" }),

    /** The point nearest `at`, within `toleranceS`. 404 if none. */
    at: (params: { at: string; toleranceS?: number; source?: LocationSource }): Promise<PointAt> =>
      this.call<PointAt>({
        method: "GET",
        url: "/v1/locations/lookup",
        query: { at: params.at, tolerance_s: params.toleranceS, source: params.source },
      }),
  };

  readonly rules = {
    /** Fire a webhook when the user enters / exits / dwells at a shared place.
     *  The returned `secret` is shown once; keep it to verify deliveries. */
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

    /** Every rule this app holds for the user, place and zone alike. */
    list: (): Promise<RuleSummary[]> =>
      this.call<RuleSummary[]>({ method: "GET", url: "/v1/rules/place" }),

    deletePlace: (ruleId: string): Promise<void> =>
      this.call<void>({ method: "DELETE", url: `/v1/rules/place/${encodeURIComponent(ruleId)}` }),

    deleteZone: (ruleId: string): Promise<void> =>
      this.call<void>({ method: "DELETE", url: `/v1/rules/zone/${encodeURIComponent(ruleId)}` }),
  };

  readonly subscriptions = {
    /** One subscription per grant; registering again replaces it and mints a
     *  new secret. */
    register: (params: {
      events: readonly ConnectionEventName[];
      webhookUrl: string;
    }): Promise<CreatedSubscription> =>
      this.call<CreatedSubscription>({
        method: "POST",
        url: "/v1/subscriptions",
        body: { events: [...params.events], webhook_url: params.webhookUrl },
      }),

    get: (): Promise<SubscriptionSummary | null> =>
      this.call<SubscriptionSummary | null>({ method: "GET", url: "/v1/subscriptions" }),

    remove: (subscriptionId: string): Promise<void> =>
      this.call<void>({
        method: "DELETE",
        url: `/v1/subscriptions/${encodeURIComponent(subscriptionId)}`,
      }),
  };

  // -------------------------------------------------------------------------

  private async call<T>(req: Omit<HttpRequest, "headers">): Promise<T> {
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
      this.refreshing = this.refreshImpl(this.tokens.refreshToken)
        .then(async (next) => {
          this.tokens = {
            refreshToken: next.refreshToken,
            accessToken: next.accessToken,
            accessTokenExpiresAt: next.accessTokenExpiresAt,
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

function ruleBody(params: BaseRuleParams): Record<string, unknown> {
  return {
    type: params.type,
    webhook_url: params.webhookUrl,
    ...(params.dwellMinutes !== undefined ? { dwell_minutes: params.dwellMinutes } : {}),
    ...(params.maxEventAgeS !== undefined ? { max_event_age_s: params.maxEventAgeS } : {}),
  };
}

function assertRange(name: string, value: number, min: number, max: number): void {
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new RangeError(`${name} must be an integer between ${min} and ${max}, got ${value}`);
  }
}
