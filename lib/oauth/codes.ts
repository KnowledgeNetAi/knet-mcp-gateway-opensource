import "server-only";
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

export function generateAuthCode(): string {
  return randomBytes(32).toString("base64url");
}

export function hashAuthCode(raw: string): string {
  return createHash("sha256").update(raw).digest("hex");
}

export function pkceChallengeFromVerifier(verifier: string): string {
  return createHash("sha256").update(verifier).digest("base64url");
}

export function verifyPkceS256(verifier: string, challenge: string): boolean {
  if (!verifier || !challenge) return false;
  const expected = Buffer.from(pkceChallengeFromVerifier(verifier));
  const actual = Buffer.from(challenge);
  if (expected.length !== actual.length) return false;
  return timingSafeEqual(expected, actual);
}

/**
 * Authorization codes expire 60 seconds after issuance. Codes are single-use
 * (consumed_at is set on first exchange in /oauth/token) so this is the upper
 * bound on a stale code surviving a slow round-trip.
 */
export const AUTH_CODE_TTL_MS = 60_000;
