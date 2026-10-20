import { describe, it, expect } from "vitest";
import {
  generateAuthCode,
  hashAuthCode,
  verifyPkceS256,
  pkceChallengeFromVerifier,
} from "@/lib/oauth/codes";

describe("generateAuthCode", () => {
  it("returns a base64url string of >= 32 bytes entropy", () => {
    const code = generateAuthCode();
    expect(code).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(code.length).toBeGreaterThanOrEqual(43); // 32 bytes -> 43 chars b64url
  });

  it("returns distinct values across calls", () => {
    const a = generateAuthCode();
    const b = generateAuthCode();
    expect(a).not.toBe(b);
  });
});

describe("hashAuthCode", () => {
  it("is deterministic and 64-char hex", () => {
    const h1 = hashAuthCode("abc");
    const h2 = hashAuthCode("abc");
    expect(h1).toBe(h2);
    expect(h1).toMatch(/^[0-9a-f]{64}$/);
  });

  it("differs for different inputs", () => {
    expect(hashAuthCode("a")).not.toBe(hashAuthCode("b"));
  });
});

describe("verifyPkceS256", () => {
  it("matches when challenge = base64url(sha256(verifier))", () => {
    const verifier = "abc123-VERIFIER";
    const challenge = pkceChallengeFromVerifier(verifier);
    expect(verifyPkceS256(verifier, challenge)).toBe(true);
  });

  it("fails on mismatch", () => {
    expect(verifyPkceS256("foo", "wrong-challenge")).toBe(false);
  });

  it("rejects empty verifier", () => {
    expect(verifyPkceS256("", "anything")).toBe(false);
  });

  it("roundtrips a 43-char RFC 7636 verifier (known-answer)", () => {
    // RFC 7636 Appendix B fixed vectors
    const verifier = "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk";
    const expectedChallenge = "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM";
    expect(pkceChallengeFromVerifier(verifier)).toBe(expectedChallenge);
    expect(verifyPkceS256(verifier, expectedChallenge)).toBe(true);
  });
});
