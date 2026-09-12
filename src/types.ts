/**
 * Wire types. These mirror the ContextKit API field-for-field: request
 * parameters are snake_case on the wire (the SDK accepts camelCase and
 * translates), response bodies are returned as the API sends them.
 */

export const APP_SCOPES = [
  // standard — answers, not data
  "location.verify.zone",
  "location.place.current",
  "location.place.presence",
  "location.visits.read",
  "location.lookup.place",
  "location.rules.place",
  "location.rules.zone",
  "location.places.watch",
  // sensitive — raw coordinates
  "location.latest.read",
  "location.history.read",
  "location.lookup",
] as const;
export type AppScope = (typeof APP_SCOPES)[number];

export const SENSITIVE_SCOPES: readonly AppScope[] = [
  "location.latest.read",
  "location.history.read",
  "location.lookup",
];

export function isAppScope(value: string): value is AppScope {
  return (APP_SCOPES as readonly string[]).includes(value);
}

/** Limits the API enforces; the SDK checks them before sending. */
export const MIN_ZONE_RADIUS_M = 100;
export const MAX_ZONE_RADIUS_M = 10_000;
export const MIN_MAX_AGE_S = 60;
export const MAX_MAX_AGE_S = 86_400;
export const DEFAULT_MAX_AGE_S = 900;
export const MIN_DWELL_MINUTES = 5;
export const MAX_DWELL_MINUTES = 720;
export const MIN_EVENT_AGE_S = 30;
export const MAX_EVENT_AGE_S = 3600;

// ---------------------------------------------------------------------------
// Tokens

/** Raw body of POST /v1/oauth/token. */
export interface TokenResponse {
  access_token: string;
  token_type: "Bearer";
  expires_in: number;
  refresh_token: string;
  refresh_token_expires_at: string | null;
  scope: string;
  /** Pairwise per-app user id. Present once the API ships it; optional until then. */
  sub?: string;
}

/** What the integrator persists per user. Refresh tokens ROTATE: every
 *  refresh returns a new one and invalidates the old, so store what
 *  `onTokens` hands you or the next refresh fails. */
export interface TokenSet {
  accessToken: string;
  /** Epoch milliseconds when `accessToken` stops working. */
  accessTokenExpiresAt: number;
  refreshToken: string;
  /** ISO timestamp of the grant's horizon, or null for no expiry. */
  refreshTokenExpiresAt: string | null;
  scopes: AppScope[];
  sub: string | null;
}

// ---------------------------------------------------------------------------
// Answers (standard tier)

export type UnknownReason = "stale" | "no_data" | "boundary";

export interface PlaceRef {
  id: string;
  label: string;
  kind: string | null;
}

export interface ZoneAnswer {
  state: "inside" | "outside" | "unknown";
  reason: UnknownReason | null;
  asOf: string | null;
  ageSeconds: number | null;
}

export interface CurrentPlaceAnswer {
  place: PlaceRef | null;
  state: "at_place" | "no_place" | "unknown";
  reason: UnknownReason | null;
  asOf: string | null;
  ageSeconds: number | null;
}

export interface PresenceAnswer {
  state: "yes" | "no" | "unknown";
  reason: UnknownReason | null;
  asOf: string | null;
  ageSeconds: number | null;
}

export interface SharedPlaceRef {
  id: string;
  label: string;
  kind: string | null;
}

export interface SharedPlaceList {
  /** Bumps whenever the set of places shared with this app changes. */
  version: number;
  places: SharedPlaceRef[];
}

// ---------------------------------------------------------------------------
// Visits

export interface Visit {
  arrival: string;
  /** null while the visit is still open. */
  departure: string | null;
  place: PlaceRef;
}

export interface VisitsPage {
  visits: Visit[];
  nextCursor: string | null;
}

export interface PlaceLookup {
  place: PlaceRef | null;
  matched: boolean;
  asOf: string | null;
  deltaSeconds: number | null;
}

// ---------------------------------------------------------------------------
// Raw points (sensitive tier)

export const LOCATION_SOURCES = ["slc", "visit", "precise"] as const;
export type LocationSource = (typeof LOCATION_SOURCES)[number];

export interface LocationPoint {
  id: string;
  /** When the fix was measured. ISO8601 UTC. */
  timestamp: string;
  lat: number;
  lon: number;
  horizontalAccuracy?: number;
  altitude?: number;
  speed?: number;
  course?: number;
  source: LocationSource;
  visitArrival?: string;
  visitDeparture?: string;
  batteryLevel?: number;
  deviceId?: string;
}

export interface PointsPage {
  points: LocationPoint[];
  nextCursor?: string;
}

export interface LatestPoint {
  point: LocationPoint;
  ageSeconds: number;
}

export interface PointAt {
  point: LocationPoint;
  deltaSeconds: number;
}

export interface DaysWithData {
  /** "YYYY-MM-DD" in the requested timezone. */
  days: string[];
}

// ---------------------------------------------------------------------------
// Rules + subscriptions

export type RuleType = "enter" | "exit" | "dwell";

export type RuleTarget =
  | { place_id: string; label: string }
  | { lat: number; lon: number; radius_m: number; label: string };

export interface RuleSummary {
  id: string;
  type: RuleType;
  target: RuleTarget;
  dwell_minutes: number | null;
  max_event_age_s: number | null;
  webhook_url: string;
  disabled_at: string | null;
  created_at: string;
}

/** Returned once, at creation. Sign-verify every delivery with it. */
export type CreatedRule = RuleSummary & { secret: string };

export const CONNECTION_EVENTS = ["places.changed"] as const;
export type ConnectionEventName = (typeof CONNECTION_EVENTS)[number];

export interface SubscriptionSummary {
  id: string;
  events: string[];
  webhook_url: string;
  disabled_at: string | null;
  created_at: string;
}

export type CreatedSubscription = SubscriptionSummary & { secret: string };

// ---------------------------------------------------------------------------
// Webhook bodies

export interface RuleWebhookEvent {
  event_id: string;
  rule_id: string;
  grant_id: string;
  /** "place.enter" | "place.exit" | "place.dwell" | "zone.enter" | ... */
  type: string;
  occurred_at: string;
  target: { place_id?: string; label: string };
}

export interface ConnectionWebhookEvent {
  event_id: string;
  subscription_id: string;
  grant_id: string;
  type: ConnectionEventName;
  occurred_at: string;
  places_version: number;
}

export type WebhookEvent = RuleWebhookEvent | ConnectionWebhookEvent;

export function isRuleEvent(event: WebhookEvent): event is RuleWebhookEvent {
  return "rule_id" in event;
}

export function isConnectionEvent(event: WebhookEvent): event is ConnectionWebhookEvent {
  return "subscription_id" in event;
}
