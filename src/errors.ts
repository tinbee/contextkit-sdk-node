/**
 * Every failure the SDK raises is a ContextKitError. Subclasses tell the
 * caller what to DO, which is the only reason to distinguish them:
 *
 *   TokenRevokedError   → the user must reconnect; stop retrying
 *   RateLimitedError    → wait `retryAfterSeconds`, then retry
 *   TimeoutError / NetworkError → transient; retry with backoff
 *   ValidationError / ScopeError / NotFoundError → caller bug or stale id; do not retry
 *
 * "unknown" answers are NOT errors. They come back as values.
 */
export class ContextKitError extends Error {
  readonly code: string;
  readonly status: number | null;
  readonly body: unknown;

  constructor(message: string, code: string, status: number | null = null, body: unknown = null) {
    super(message);
    this.name = new.target.name;
    this.code = code;
    this.status = status;
    this.body = body;
  }
}

/**
 * 400 — the request shape was wrong. `messages` is what the API said.
 * `error` is the API's machine code when it sent one (`"invalid_purpose"`
 * for a purpose that is missing, unknown, or not usable for this scope), and
 * `detail` its explanation.
 */
export class ValidationError extends ContextKitError {
  readonly messages: string[];
  readonly error: string | null;
  readonly detail: string | null;
  constructor(messages: string[], body: unknown) {
    const error = stringField(body, "error");
    const detail = stringField(body, "detail");
    const all = messages.length ? messages : detail ? [detail] : [];
    super(all.join("; ") || "validation failed", "validation", 400, body);
    this.messages = all;
    this.error = error;
    this.detail = detail;
  }
}

/** 401 that a refresh could not fix, or a refresh that itself failed. The
 *  grant is gone (revoked, expired, app deactivated, or the refresh token
 *  was replayed). Send the user back through the connect flow. */
export class TokenRevokedError extends ContextKitError {
  constructor(message = "grant is no longer valid; the user must reconnect", body: unknown = null) {
    super(message, "token_revoked", 401, body);
  }
}

/** 403 — the grant does not carry the scope this call needs
 *  (`error: "missing_scope"`). Request it at consent. */
export class ScopeError extends ContextKitError {
  constructor(message: string, body: unknown, code = "scope") {
    super(message, code, 403, body);
  }
}

/**
 * 403 `scope_expired` — the grant HAD this sensitive scope, but its tier
 * lapsed. The rest of the connection keeps working. Tell the user access to
 * their raw location has ended and offer renewal by sending them through
 * consent again; until `renewalGraceEndsAt` that is a single tap.
 */
export class ScopeExpiredError extends ScopeError {
  /** ISO 8601; when the sensitive tier ended. */
  readonly sensitiveExpiredAt: string | null;
  /** ISO 8601; after this the scopes are removed and renewal is a full
   *  re-consent. */
  readonly renewalGraceEndsAt: string | null;
  constructor(message: string, body: unknown) {
    super(message, body, "scope_expired");
    this.sensitiveExpiredAt =
      stringField(body, "sensitive_expired_at") ?? stringField(body, "sensitive_expires_at");
    this.renewalGraceEndsAt = stringField(body, "renewal_grace_ends_at");
  }
}

/** 404 — unshared and nonexistent are deliberately the same answer. */
export class NotFoundError extends ContextKitError {
  constructor(message: string, body: unknown) {
    super(message, "not_found", 404, body);
  }
}

/** 429 — per-app budget or rate limit. Honour `retryAfterSeconds`. */
export class RateLimitedError extends ContextKitError {
  readonly retryAfterSeconds: number | null;
  constructor(message: string, retryAfterSeconds: number | null, body: unknown) {
    super(message, "rate_limited", 429, body);
    this.retryAfterSeconds = retryAfterSeconds;
  }
}

/** Any other non-2xx. */
export class ApiError extends ContextKitError {
  constructor(message: string, status: number, body: unknown) {
    super(message, "api", status, body);
  }
}

export class TimeoutError extends ContextKitError {
  constructor(url: string, timeoutMs: number) {
    super(`request to ${url} timed out after ${timeoutMs}ms`, "timeout");
  }
}

export class NetworkError extends ContextKitError {
  override readonly cause: unknown;
  constructor(url: string, cause: unknown) {
    super(`request to ${url} failed: ${describe(cause)}`, "network");
    this.cause = cause;
  }
}

/** A webhook delivery that failed signature or freshness checks. */
export class WebhookVerificationError extends ContextKitError {
  constructor(detail: string) {
    super(detail, "webhook_verification");
  }
}

function stringField(body: unknown, key: string): string | null {
  if (!body || typeof body !== "object") return null;
  const value = (body as Record<string, unknown>)[key];
  return typeof value === "string" ? value : null;
}

function describe(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
