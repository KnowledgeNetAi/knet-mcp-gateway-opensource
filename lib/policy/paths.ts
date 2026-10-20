/**
 * True when flat `name` matches `pattern`.
 *
 * FLAT NAMES ONLY — e.g. tool names, which the config schema constrains to
 * `^[a-z][a-z0-9_]*$` and so can never contain a dot. Do NOT use this for
 * field paths: it splits on "." with no notion of "one path segment", so a
 * field whose actual key contains a literal dot would be silently
 * (mis)treated as multiple path segments. Field paths must use `matchesPath`
 * instead, which takes the path as an array of literal segments and can
 * never split one.
 */
export function matchesPattern(name: string, pattern: string): boolean {
  if (pattern === "*") return true;

  if (pattern.endsWith(".*")) {
    const prefix = pattern.slice(0, -2);
    return name === prefix || name.startsWith(`${prefix}.`);
  }
  return name === pattern;
}

/**
 * True when flat `name` is a strict ancestor of `pattern`, so a matcher must
 * descend to find matches. Same flat-name-only caveat as `matchesPattern` —
 * do not use for field paths.
 */
export function isPrefixOfPattern(name: string, pattern: string): boolean {
  if (pattern === "*") return true;
  const literal = pattern.endsWith(".*") ? pattern.slice(0, -2) : pattern;
  return literal.startsWith(`${name}.`);
}

/**
 * True when tool `name` matches `pattern`, under the single dialect legal
 * for tool-name patterns: exact equality, a bare `"*"` meaning everything,
 * or a trailing `"*"` as a literal prefix (`"customer_*"`).
 *
 * This is deliberately narrower than `matchesPattern`: tool names are
 * constrained by the config schema to `^[a-z][a-z0-9_]*$` and so can never
 * contain a dot, which means the dotted `"prefix.*"` subtree dialect that
 * `matchesPattern` supports for field paths must never be reachable through
 * a tool pattern — a role author writing `"customer_get.*"` must not
 * thereby grant `"customer_get"` itself. Grant computation (`grants.ts`)
 * and config-load validation (`config/load.ts`) both call this single
 * function so their notions of "the tools a role grants" cannot drift.
 */
export function matchesToolPattern(name: string, pattern: string): boolean {
  if (pattern === "*") return true;
  if (pattern.endsWith("*")) return name.startsWith(pattern.slice(0, -1));
  return name === pattern;
}

/** Split a dotted pattern into its literal segments, and whether it ends in a wildcard. */
function splitPattern(pattern: string): { literalSegments: string[]; wildcard: boolean } {
  const segments = pattern.split(".");
  const wildcard = segments[segments.length - 1] === "*";
  return { literalSegments: wildcard ? segments.slice(0, -1) : segments, wildcard };
}

/**
 * True when `pathSegments` — a field path built up one segment per actual
 * object key, NEVER split on "." within a segment — is inside the subtree
 * `pattern` selects.
 *
 * Pattern strings ARE split on "." (config authors write field paths with
 * dots as separators between keys), but a vendor key that itself contains a
 * literal dot is still exactly one segment and can therefore never be
 * addressed by a multi-segment pattern, nor accidentally match one. This is
 * what keeps deny-by-default sound even when upstream data supplies a key
 * like `"locations.internal_credit_memo"`.
 *
 * Semantics, same as `matchesPattern`: pattern `"*"` matches everything; a
 * trailing `.*` matches its literal prefix segments exactly (so
 * `"locations.*"` matches path `["locations"]` itself, and everything
 * beneath it); otherwise every segment must be equal, element-for-element,
 * and the path must be exactly as long as the pattern.
 */
export function matchesPath(pathSegments: string[], pattern: string): boolean {
  if (pattern === "*") return true;

  const { literalSegments, wildcard } = splitPattern(pattern);

  if (wildcard) {
    if (pathSegments.length < literalSegments.length) return false;
    return literalSegments.every((seg, i) => seg === pathSegments[i]);
  }

  if (pathSegments.length !== literalSegments.length) return false;
  return literalSegments.every((seg, i) => seg === pathSegments[i]);
}

/**
 * True when `pathSegments` is a strict ancestor of `pattern`'s segments, so
 * the walker must descend further to find matches. Same segment-array
 * discipline as `matchesPath` — a vendor key with a literal dot is one
 * segment and can never be treated as a partial-prefix match.
 */
export function isPrefixOfPath(pathSegments: string[], pattern: string): boolean {
  if (pattern === "*") return true;

  const { literalSegments } = splitPattern(pattern);

  if (pathSegments.length >= literalSegments.length) return false;
  return pathSegments.every((seg, i) => seg === literalSegments[i]);
}
