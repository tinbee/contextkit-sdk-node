import { createHmac, timingSafeEqual } from "node:crypto";
import { WebhookVerificationError } from "./errors.js";
import type { WebhookEvent } from "./types.js";

/**
 * ContextKit signs every delivery Stripe-style:
 *   X-ContextKit-Signature: t=<unix seconds>,v1=<hex hmac-sha256(secret, `${t}.${body}`)>[,v1=...]
 * While an app webhook endpoint's secret is being rotated, the header carries
 * one v1 per unexpired secret, so a receiver holding either secret verifies.
 * Retries are re-signed, so a receiver never needs a window wider than
 * realistic clock skew. This must agree byte-for-byte with the API's
 * webhook-delivery.service.ts and the Explorer relay's signature.ts.
 */
export const RECOMMENDED_TOLERANCE_S = 60;
export const MAX_TOLERANCE_S = 300;
export const SIGNATURE_HEADER = "x-contextkit-signature";

/** Something that remembers event ids it has already accepted. Needed for
 *  replay protection across your own retries or a duplicated delivery. */
export interface ReplayGuard {
  /** Return true if this id was already seen; otherwise record it. */
  seen(eventId: string, occurredAtMs: number): boolean | Promise<boolean>;
}

export interface VerifyWebhookParams {
  /** The EXACT bytes received. Re-serialising a parsed body breaks the HMAC. */
  rawBody: Buffer | string;
  /** The X-ContextKit-Signature header value. */
  signature: string | string[] | undefined;
  /**
   * Your app webhook endpoint's secret, shown once when you register (or
   * rotate) the endpoint in the developer portal. For a legacy rule or
   * subscription, the secret returned when it was created.
   */
  secret: string;
  /** Seconds of clock skew to allow. Default 60, max 300. */
  toleranceS?: number;
  replayGuard?: ReplayGuard;
  /** Injectable clock, epoch ms. */
  now?: number;
}

/**
 * Verify a delivery and return its parsed event. Throws
 * WebhookVerificationError on any failure — respond 400 and do NOT act.
 */
export async function verifyWebhook(params: VerifyWebhookParams): Promise<WebhookEvent> {
  const header = Array.isArray(params.signature) ? params.signature[0] : params.signature;
  if (!header) throw new WebhookVerificationError(`missing ${SIGNATURE_HEADER} header`);
  const parsed = parseSignatureHeader(header);
  if (!parsed) throw new WebhookVerificationError("malformed signature header");

  const toleranceS = Math.min(params.toleranceS ?? RECOMMENDED_TOLERANCE_S, MAX_TOLERANCE_S);
  const nowS = Math.floor((params.now ?? Date.now()) / 1000);
  const skew = nowS - parsed.timestamp;
  if (Math.abs(skew) > toleranceS) {
    throw new WebhookVerificationError(`timestamp ${skew}s outside ${toleranceS}s tolerance`);
  }

  const body = Buffer.isBuffer(params.rawBody)
    ? params.rawBody
    : Buffer.from(params.rawBody, "utf8");
  const expected = signPayload(body, parsed.timestamp, params.secret);
  // During a secret rotation the header carries one v1 per unexpired secret
  // (old and new, for 24 h). Any match passes. Every candidate is compared,
  // in constant time, so timing does not reveal which one matched.
  let matched = false;
  for (const candidate of parsed.signatures) {
    if (constantTimeEquals(candidate, expected)) matched = true;
  }
  if (!matched) {
    throw new WebhookVerificationError("no v1 signature matched — wrong secret or tampered body");
  }

  const event = parseEvent(body);
  if (params.replayGuard && event.event_id !== undefined) {
    const occurredAtMs = event.occurred_at ? Date.parse(event.occurred_at) : Date.now();
    if (await params.replayGuard.seen(event.event_id, occurredAtMs)) {
      throw new WebhookVerificationError(`event ${event.event_id} already processed`);
    }
  }
  return event;
}

/** Build the header for a body — for tests and for simulating deliveries.
 *  Pass several secrets to simulate a rotation: one v1 per secret. */
export function signWebhook(
  body: Buffer | string,
  secret: string | readonly string[],
  atMs = Date.now(),
): string {
  const t = Math.floor(atMs / 1000);
  const buf = Buffer.isBuffer(body) ? body : Buffer.from(body, "utf8");
  const secrets = typeof secret === "string" ? [secret] : secret;
  return [`t=${t}`, ...secrets.map((s) => `v1=${signPayload(buf, t, s)}`)].join(",");
}

export function parseSignatureHeader(
  header: string,
): { timestamp: number; signatures: string[] } | null {
  let timestamp: number | null = null;
  const signatures: string[] = [];
  for (const part of header.split(",")) {
    const eq = part.indexOf("=");
    if (eq === -1) return null;
    const key = part.slice(0, eq).trim();
    const value = part.slice(eq + 1).trim();
    if (key === "t") {
      const n = Number(value);
      if (!Number.isFinite(n)) return null;
      timestamp = n;
    } else if (key === "v1") {
      signatures.push(value.toLowerCase());
    }
    // Unknown keys are ignored so a future v2 does not break v1 receivers.
  }
  if (timestamp === null || signatures.length === 0) return null;
  return { timestamp, signatures };
}

/**
 * A process-local replay guard. Fine for a single instance; behind more than
 * one replica, back `ReplayGuard` with something shared (Redis SET NX EX).
 */
export class InMemoryReplayGuard implements ReplayGuard {
  private readonly ids = new Map<string, number>();
  constructor(private readonly ttlMs = 10 * 60_000) {}

  seen(eventId: string, _occurredAtMs: number): boolean {
    const now = Date.now();
    for (const [id, at] of this.ids) if (now - at > this.ttlMs) this.ids.delete(id);
    if (this.ids.has(eventId)) return true;
    this.ids.set(eventId, now);
    return false;
  }
}

function signPayload(body: Buffer, timestamp: number, secret: string): string {
  return createHmac("sha256", secret)
    .update(Buffer.concat([Buffer.from(`${timestamp}.`, "utf8"), body]))
    .digest("hex");
}

function parseEvent(body: Buffer): WebhookEvent {
  let data: unknown;
  try {
    data = JSON.parse(body.toString("utf8"));
  } catch {
    throw new WebhookVerificationError("body is not JSON");
  }
  const obj = data as { event_id?: unknown; occurred_at?: unknown; type?: unknown } | null;
  // A portal "Send test" ping may carry only its type and endpoint ids.
  const isPing = !!obj && typeof obj === "object" && obj.type === "ping";
  if (
    !obj ||
    typeof obj !== "object" ||
    typeof obj.type !== "string" ||
    (!isPing && (typeof obj.event_id !== "string" || typeof obj.occurred_at !== "string"))
  ) {
    throw new WebhookVerificationError("body is not a ContextKit event");
  }
  return data as WebhookEvent;
}

function constantTimeEquals(a: string, b: string): boolean {
  const left = Buffer.from(a, "utf8");
  const right = Buffer.from(b, "utf8");
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}
