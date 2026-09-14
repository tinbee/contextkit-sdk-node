# Changelog

## 0.4.0

Two-tier grant expiry, registered purposes, and app-level webhook endpoints.

### Breaking

- **`purpose` is required on every raw-location read**: `locations.latest`,
  `locations.at`, `locations.range` and `locations.days`. Pass the key of a
  purpose registered for your app in the developer portal; it is sent as the
  `purpose` query parameter. A missing key, or one that does not match
  `^[a-z][a-z0-9_]{2,39}$`, is refused with a `TypeError` before any request.
  `locations.latest()` now takes `{ purpose }`.
- `ConnectionWebhookEvent` is now a union of `PlacesChangedEvent`,
  `SensitiveExpiringEvent`, `SensitiveLapsedEvent` and `SensitiveRemovedEvent`,
  and `WebhookEvent` also includes `PingEvent`. Code that read `places_version`
  straight after `isConnectionEvent` must narrow with `isPlacesChangedEvent`
  first. `isConnectionEvent` now checks the event `type`; `subscription_id` is
  optional, because app-endpoint deliveries do not carry it.
- `RuleWebhookEvent.type` is now `RuleEventType` (`place.enter` … `zone.dwell`)
  instead of `string`, and `RuleSummary.webhook_url` is `string | null`.
- `CreatedRule.secret` is optional; new rules do not return one.
- `TokenSet` has a new required field, `sensitiveScopesExpiresAt`. Only code
  that builds a `TokenSet` by hand is affected.

### Added

- **App webhook endpoints.** Register them in the developer portal, one secret
  per endpoint; every event for every connection of the app is delivered there.
  - `webhookUrl` is optional on `rules.createZone` / `rules.createPlace`. Omit it
    to deliver to the endpoints subscribed to `rule.fired`. If given, it must
    equal a registered endpoint URL (400 `webhook_url_not_registered`).
  - `verifyWebhook` accepts a header with several `v1=` signatures (one per
    unexpired secret during a 24-hour rotation overlap) and passes if any
    matches. Each signature is compared in constant time; tolerance and replay
    checks are unchanged. `signWebhook` accepts an array of secrets to simulate
    a rotation.
  - `PingEvent` + `isPingEvent` for the portal's "Send test".
  - `app_id` and `endpoint_id` on event payload types (absent on legacy
    per-rule and subscription deliveries).
  - `APP_WEBHOOK_EVENTS`, `RULE_EVENT_TYPES`.
- `TokenSet.sensitiveScopesExpiresAt` (epoch ms or null), from the token
  response's `sensitive_scopes_expire_at`.
- `ScopeExpiredError extends ScopeError` for 403 `scope_expired`, with
  `sensitiveExpiredAt` and `renewalGraceEndsAt`. `ScopeError` alone still means
  `missing_scope`.
- `ValidationError.error` and `ValidationError.detail`, so a 400
  `invalid_purpose` says what was wrong.
- `UserClient.me()`: GET /v1/me in camelCase — effective `scopes`,
  `heldScopes`, `expiresAt`, `sensitiveExpiresAt`, `sensitiveLapsedAt`,
  `renewalGraceEndsAt`, `connectedAt`, `sub`, `externalUserId`,
  `placesVersion`.
- Connection events `sensitive.expiring` (`days_left` 14 or 7),
  `sensitive.lapsed` and `sensitive.removed`, added to `CONNECTION_EVENTS`,
  with guards `isSensitiveExpiringEvent`, `isSensitiveLapsedEvent`,
  `isSensitiveRemovedEvent` and `isPlacesChangedEvent`.
- `PURPOSE_KEY_PATTERN` and `isPurposeKey`.
- `UserTokens.scopes` (optional); a full `TokenSet` already carries it.

### Deprecated

- `subscriptions.register`, `subscriptions.get`, `subscriptions.remove` (and
  `SubscriptionSummary`, `CreatedSubscription`): connection events now reach app
  webhook endpoints automatically. The routes keep working this release.
- `CreatedRule.secret`: only rules created before app endpoints have one, and
  they keep signing with it until deleted.

### Fixed

- `rules.list()` always called GET /v1/rules/place, which needs
  `location.rules.place`, so an app holding only `location.rules.zone` got a
  `ScopeError`. It now calls /v1/rules/zone when the grant holds only the zone
  scope, and /v1/rules/place otherwise. Both return every rule for the grant.
