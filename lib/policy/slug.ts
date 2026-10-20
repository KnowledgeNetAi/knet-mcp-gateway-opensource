/**
 * Single source of truth for the org-slug charset.
 *
 * This lived in `lib/auth/api-key.ts`, whose comment explained it was closed
 * there because the producer (`generateApiKey`) and the consumer (`parseKey`)
 * were both in that file. Phase 2 adds two more consumers outside it — the
 * RFC 9728 resource parser and the 401 challenge header — so the contract
 * moves here and `api-key.ts` imports it. The reasoning is unchanged; only
 * the location is.
 *
 * ORG_SLUG_CHARS is spliced verbatim into `[...]` character classes. It must
 * stay a valid, self-contained character-class body: no `]`, no leading `^`,
 * no backslash. Any of those corrupts each consuming regex differently, and
 * silently, rather than failing loudly.
 */
export const ORG_SLUG_CHARS = "a-z0-9-";

const ORG_SLUG_RE = new RegExp(`^[${ORG_SLUG_CHARS}]+$`);

/**
 * The `typeof` check is load-bearing, not defensive noise:
 * `RegExp.prototype.test` coerces its argument to a string, so a JSON `null`
 * from a failed join, or an `undefined` from an optional chain, would
 * stringify to "null"/"undefined" — both of which match the charset — and
 * pass validation.
 */
export function isValidOrgSlug(v: unknown): v is string {
  return typeof v === "string" && ORG_SLUG_RE.test(v);
}
