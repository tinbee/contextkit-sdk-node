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
  /** When the sensitive tier (raw coordinates) stops working, ISO 8601. Absent
   *  or null when the grant holds no sensitive scope. */
  sensitive_scopes_expire_at?: string | null;
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
  /** The EFFECTIVE scopes: a lapsed sensitive tier is no longer listed. */
  scopes: AppScope[];
  sub: string | null;
  /**
   * Epoch milliseconds when the sensitive scopes (raw coordinates) stop
   * working, or null when the grant holds none. The rest of the grant keeps
   * working past this; renew the sensitive tier by sending the user through
   * consent again.
   */
  sensitiveScopesExpiresAt: number | null;
}

// ---------------------------------------------------------------------------
// Purposes

/**
 * A registered purpose key, as created in the developer portal. Every read of
 * raw coordinates names one; the user sees its description on consent, in
 * their access log and on renewal.
 */
export const PURPOSE_KEY_PATTERN = /^[a-z][a-z0-9_]{2,39}$/;

export function isPurposeKey(value: unknown): value is string {
  return typeof value === "string" && PURPOSE_KEY_PATTERN.test(value);
}

// ---------------------------------------------------------------------------
// GET /v1/me

/** Raw body of GET /v1/me. */
export interface MeResponse {
  sub: string;
  /** Absent from older APIs. */
  external_user_id?: string | null;
  /** Effective scopes. */
  scopes: string[];
  /** Every scope on the grant, including a lapsed sensitive tier still in its
   *  renewal grace. Absent from APIs older than the two-tier release. */
  held_scopes?: string[];
  places_version?: number;
  grant_expires_at?: string | null;
  expires_at?: string | null;
  sensitive_expires_at?: string | null;
  sensitive_lapsed_at?: string | null;
  renewal_grace_ends_at?: string | null;
  connected_at?: string | null;
}

/** Who this connection is, from the app's side. Timestamps are ISO 8601. */
export interface Me {
  /** Pairwise per-app user id. */
  sub: string;
  externalUserId: string | null;
  /** What calls may use right now. */
  scopes: AppScope[];
  /** Everything the grant holds, including a lapsed sensitive tier that can
   *  still be renewed in one tap. */
  heldScopes: AppScope[];
  placesVersion: number | null;
  /** The whole grant's horizon (standard tier); null = never. */
  expiresAt: string | null;
  /** When the sensitive tier stops (or stopped) working; null = none held. */
  sensitiveExpiresAt: string | null;
  /** Set once the sensitive tier has lapsed. */
  sensitiveLapsedAt: string | null;
  /** After this, lapsed sensitive scopes are removed from the grant. */
  renewalGraceEndsAt: string | null;
  connectedAt: string | null;
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
  /** The window the rule is evaluated in; null on either side = unbounded. */
  active_from: string | null;
  active_until: string | null;
  /** null = delivered to the app's registered endpoints subscribed to
   *  `rule.fired`. A URL is always one of those registered endpoints. */
  webhook_url: string | null;
  disabled_at: string | null;
  created_at: string;
}

export type CreatedRule = RuleSummary & {
  /**
   * @deprecated New rules have no secret of their own: deliveries are signed
   * with your app webhook endpoint's secret, shown once when you register the
   * endpoint in the developer portal. Only rules created before app endpoints
   * returned one, and they keep using it until deleted.
   */
  secret?: string;
};

export const CONNECTION_EVENTS = [
  "places.changed",
  "sensitive.expiring",
  "sensitive.lapsed",
  "sensitive.removed",
] as const;
export type ConnectionEventName = (typeof CONNECTION_EVENTS)[number];

/** What an app webhook endpoint can subscribe to (in the developer portal).
 *  `rule.fired` covers every place/zone enter, exit and dwell delivery. */
export const APP_WEBHOOK_EVENTS = ["rule.fired", ...CONNECTION_EVENTS] as const;
export type AppWebhookEventName = (typeof APP_WEBHOOK_EVENTS)[number];

/** The `type` of a delivery an endpoint receives for `rule.fired`. */
export const RULE_EVENT_TYPES = [
  "place.enter",
  "place.exit",
  "place.dwell",
  "zone.enter",
  "zone.exit",
  "zone.dwell",
] as const;
export type RuleEventType = (typeof RULE_EVENT_TYPES)[number];

/** @deprecated Subscriptions are replaced by app webhook endpoints. */
export interface SubscriptionSummary {
  id: string;
  events: string[];
  webhook_url: string;
  disabled_at: string | null;
  created_at: string;
}

/** @deprecated Subscriptions are replaced by app webhook endpoints. */
export type CreatedSubscription = SubscriptionSummary & { secret: string };

// ---------------------------------------------------------------------------
// Webhook bodies

/**
 * Fields every delivery carries. `app_id` and `endpoint_id` identify the app
 * webhook endpoint that received it; both are absent on deliveries from a
 * legacy per-rule URL or a (deprecated) subscription.
 */
interface WebhookEventBase {
  event_id: string;
  occurred_at: string;
  app_id?: string;
  endpoint_id?: string;
}

/** A rule fired (endpoint subscription `rule.fired`). */
export interface RuleWebhookEvent extends WebhookEventBase {
  rule_id: string;
  grant_id: string;
  type: RuleEventType;
  target: { place_id?: string; label: string };
}

interface ConnectionEventBase extends WebhookEventBase {
  grant_id: string;
  /** Only on deliveries through a deprecated subscription. */
  subscription_id?: string;
}

/** The set of places the user shares with this app changed. */
export interface PlacesChangedEvent extends ConnectionEventBase {
  type: "places.changed";
  places_version: number;
}

/** The sensitive tier ends soon — sent once at 14 days and once at 7. */
export interface SensitiveExpiringEvent extends ConnectionEventBase {
  type: "sensitive.expiring";
  sensitive_expires_at: string;
  days_left: 14 | 7;
  scopes: string[];
}

/** The sensitive tier has ended. The scopes stay renewable until
 *  `renewal_grace_ends_at`. */
export interface SensitiveLapsedEvent extends ConnectionEventBase {
  type: "sensitive.lapsed";
  sensitive_expires_at: string;
  renewal_grace_ends_at: string;
  scopes: string[];
}

/** The renewal grace ended; the sensitive scopes were removed from the grant. */
export interface SensitiveRemovedEvent extends ConnectionEventBase {
  type: "sensitive.removed";
  scopes: string[];
}

export type ConnectionWebhookEvent =
  PlacesChangedEvent | SensitiveExpiringEvent | SensitiveLapsedEvent | SensitiveRemovedEvent;

/** Sent by "Send test" in the developer portal. Acknowledge it with a 2xx and
 *  do nothing else. */
export interface PingEvent {
  type: "ping";
  app_id: string;
  endpoint_id: string;
  event_id?: string;
  occurred_at?: string;
}

/** Every event type this SDK version knows, each checked against its full shape. */
export type KnownWebhookEvent = RuleWebhookEvent | ConnectionWebhookEvent | PingEvent;

/**
 * A delivery whose `type` is newer than this SDK. verifyWebhook still returns it
 * (signature and common fields checked) so you can acknowledge it with a 2xx and
 * ignore it; upgrade the SDK to handle it.
 */
export interface UnknownWebhookEvent {
  type: string;
  event_id: string;
  occurred_at: string;
  app_id?: string;
  endpoint_id?: string;
  [field: string]: unknown;
}

/**
 * What verifyWebhook returns. Narrow with the `is*Event` guards (or isKnownEvent)
 * rather than by comparing `type` alone: an unknown event's `type` is any string.
 */
export type WebhookEvent = KnownWebhookEvent | UnknownWebhookEvent;

// The guards check each shape's required fields, not just `type`: they are type
// predicates, and verifyWebhook only validates what every event has in common.
type Fields = Record<string, unknown>;

/** The value as a plain object, or null — so a guard given null, a string or an
 *  array (from plain JS or an unsafe cast) returns false instead of throwing. */
function asFields(value: unknown): Fields | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Fields)
    : null;
}

function hasStrings(event: Fields, ...keys: string[]): boolean {
  return keys.every((key) => typeof event[key] === "string");
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}

function isEventBase(event: Fields): boolean {
  return hasStrings(event, "event_id", "occurred_at");
}

export function isKnownEvent(event: WebhookEvent): event is KnownWebhookEvent {
  return isPingEvent(event) || isRuleEvent(event) || isConnectionEvent(event);
}

export function isPingEvent(event: WebhookEvent): event is PingEvent {
  const e = asFields(event);
  return !!e && e.type === "ping" && hasStrings(e, "app_id", "endpoint_id");
}

export function isRuleEvent(event: WebhookEvent): event is RuleWebhookEvent {
  const e = asFields(event);
  if (!e) return false;
  const target = asFields(e.target);
  return (
    isEventBase(e) &&
    hasStrings(e, "rule_id", "grant_id") &&
    (RULE_EVENT_TYPES as readonly unknown[]).includes(e.type) &&
    !!target &&
    typeof target.label === "string" &&
    (target.place_id === undefined || typeof target.place_id === "string")
  );
}

export function isConnectionEvent(event: WebhookEvent): event is ConnectionWebhookEvent {
  return (
    isPlacesChangedEvent(event) ||
    isSensitiveExpiringEvent(event) ||
    isSensitiveLapsedEvent(event) ||
    isSensitiveRemovedEvent(event)
  );
}

function isConnectionBase(event: WebhookEvent, type: ConnectionEventName): Fields | null {
  const e = asFields(event);
  return e && e.type === type && isEventBase(e) && hasStrings(e, "grant_id") ? e : null;
}

export function isPlacesChangedEvent(event: WebhookEvent): event is PlacesChangedEvent {
  const e = isConnectionBase(event, "places.changed");
  return !!e && Number.isInteger(e.places_version);
}

export function isSensitiveExpiringEvent(event: WebhookEvent): event is SensitiveExpiringEvent {
  const e = isConnectionBase(event, "sensitive.expiring");
  return (
    !!e &&
    hasStrings(e, "sensitive_expires_at") &&
    (e.days_left === 14 || e.days_left === 7) &&
    isStringArray(e.scopes)
  );
}

export function isSensitiveLapsedEvent(event: WebhookEvent): event is SensitiveLapsedEvent {
  const e = isConnectionBase(event, "sensitive.lapsed");
  return (
    !!e && hasStrings(e, "sensitive_expires_at", "renewal_grace_ends_at") && isStringArray(e.scopes)
  );
}

export function isSensitiveRemovedEvent(event: WebhookEvent): event is SensitiveRemovedEvent {
  const e = isConnectionBase(event, "sensitive.removed");
  return !!e && isStringArray(e.scopes);
}
