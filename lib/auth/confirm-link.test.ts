import { describe, it, expect } from "vitest";
import {
  readConfirmIntent,
  safeNext,
  isEmailOtpType,
  confirmCopy,
} from "@/lib/auth/confirm-link";

describe("safeNext", () => {
  it("defaults to /set-password when absent or not a local path", () => {
    for (const bad of [null, undefined, "", "https://evil.com", "evil.com"]) {
      expect(safeNext(bad)).toBe("/set-password");
    }
  });

  it("rejects protocol-relative and backslash open-redirects", () => {
    expect(safeNext("//evil.com")).toBe("/set-password");
    expect(safeNext("/\\evil.com")).toBe("/set-password");
  });

  it("passes through same-origin absolute paths", () => {
    expect(safeNext("/me")).toBe("/me");
    expect(safeNext("/set-password")).toBe("/set-password");
  });
});

describe("isEmailOtpType", () => {
  it("accepts the types Supabase puts in email links", () => {
    for (const t of ["recovery", "invite", "signup", "magiclink", "email_change", "email"]) {
      expect(isEmailOtpType(t)).toBe(true);
    }
  });

  it("rejects anything else, so junk never reaches verifyOtp", () => {
    for (const t of ["", "sms", "phone_change", "RECOVERY", null, undefined, 7]) {
      expect(isEmailOtpType(t)).toBe(false);
    }
  });
});

describe("readConfirmIntent", () => {
  it("reads a token_hash link", () => {
    expect(
      readConfirmIntent({
        token_hash: "abc123",
        type: "recovery",
        next: "/set-password",
      }),
    ).toEqual({
      kind: "otp",
      tokenHash: "abc123",
      type: "recovery",
      next: "/set-password",
    });
  });

  it("reads a PKCE code link", () => {
    expect(readConfirmIntent({ code: "pkce-code" })).toEqual({
      kind: "pkce",
      code: "pkce-code",
      next: "/set-password",
    });
  });

  it("is invalid when the token_hash carries an unusable type", () => {
    expect(
      readConfirmIntent({ token_hash: "abc123", type: "sms" }),
    ).toEqual({ kind: "invalid" });
    expect(readConfirmIntent({ token_hash: "abc123" })).toEqual({
      kind: "invalid",
    });
  });

  it("is invalid when the link carries no credential at all", () => {
    expect(readConfirmIntent({})).toEqual({ kind: "invalid" });
    expect(readConfirmIntent({ next: "/me" })).toEqual({ kind: "invalid" });
  });

  it("applies safeNext to the redirect target", () => {
    const intent = readConfirmIntent({
      token_hash: "abc123",
      type: "invite",
      next: "//evil.com",
    });
    expect(intent).toMatchObject({ next: "/set-password" });
  });
});

describe("confirmCopy", () => {
  it("names the action for recovery and invite links", () => {
    expect(
      confirmCopy({
        kind: "otp",
        tokenHash: "x",
        type: "recovery",
        next: "/set-password",
      }).heading,
    ).toBe("Reset your password");
    expect(
      confirmCopy({
        kind: "otp",
        tokenHash: "x",
        type: "invite",
        next: "/set-password",
      }).heading,
    ).toBe("Accept your invitation");
  });

  it("falls back to generic copy for other link types", () => {
    expect(confirmCopy({ kind: "pkce", code: "x", next: "/" }).heading).toBe(
      "Confirm your email",
    );
  });
});
