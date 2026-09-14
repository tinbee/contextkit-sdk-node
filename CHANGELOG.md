# Changelog

## 0.4.0

Two-tier grant expiry and registered purposes.

### Breaking

- **`purpose` is required on every raw-location read**: `locations.latest`,
  `locations.at`, `locations.range` and `locations.days`. Pass the key of a
  purpose registered for your app in the developer portal; it is sent as the
  `purpose` query parameter. A missing key, or one that does not match
  `^[a-z][a-z0-9_]{2,39}$`, is refused with a `TypeError` before any request.
  `locations.latest()` now takes `{ purpose }`.
- `ConnectionWebhookEvent` is now a union of `PlacesChangedEvent`,
  `SensitiveExpiringEvent`, `SensitiveLapsedEvent` and `SensitiveRemovedEvent`.
  Code that read `places_version` straight after `isConnectionEvent` must
  narrow with `isPlacesChangedEvent` first.
- `TokenSet` has a new required field, `sensitiveScopesExpiresAt`. Only code
  that builds a `TokenSet` by hand is affected.

### Added

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

### Fixed

- `rules.list()` always called GET /v1/rules/place, which needs
  `location.rules.place`, so an app holding only `location.rules.zone` got a
  `ScopeError`. It now calls /v1/rules/zone when the grant holds only the zone
  scope, and /v1/rules/place otherwise. Both return every rule for the grant.
