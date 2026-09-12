import { createHash, randomBytes } from "node:crypto";

/** 43-character base64url verifier (32 random bytes), the RFC 7636 minimum. */
export function generateCodeVerifier(): string {
  return base64url(randomBytes(32));
}

/** S256 challenge for a verifier — the only method the API accepts. */
export function codeChallenge(verifier: string): string {
  return base64url(createHash("sha256").update(verifier, "utf8").digest());
}

/** 32 random bytes as base64url; use as the OAuth `state`. */
export function generateState(): string {
  return base64url(randomBytes(32));
}

function base64url(buf: Buffer): string {
  return buf.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
