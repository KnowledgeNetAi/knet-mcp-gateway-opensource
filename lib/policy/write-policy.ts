import type { Json } from "@/lib/types";

/**
 * Decide whether a caller-supplied bag of fields may be written, given the
 * write allowlist their role grants for this tool.
 *
 * Returns every problem found; an empty array means the write is permitted.
 * Never throws and never mutates `fields` or `allow` -- callers (the MCP
 * handler, in particular) need to be able to hand this function untrusted,
 * caller-authored JSON and trust that a hostile or malformed shape produces
 * problem strings, not an exception that turns a policy check into a 500.
 *
 * This is deliberately NOT built on top of `filterFields`/`matchesPath` in
 * `filter.ts`, even though both modules are "compare a bag of fields
 * against a role's allowlist." That function prunes an upstream RESPONSE:
 * deny-by-default there only ever narrows what a caller can already see,
 * so a wildcard grant ("*", "locations.*") is safe -- at worst it exposes
 * a field nobody meant to expose, and the blast radius is "this caller can
 * read one thing they shouldn't." Here the allowlist gates a caller-
 * authored WRITE: a wildcard grant would let a caller set ANY field on the
 * underlying record, including ones no reviewer ever looked at when they
 * wrote the allowlist -- e.g. a role meant to grant "email, phone" would,
 * under wildcard semantics, also grant "lifecyclestage" or any other
 * property an upstream happens to expose today or adds tomorrow. Reading and
 * writing are not symmetric operations and must not share a matcher.
 *
 * Nested writes use exact structural leaf paths. Array indices are normalized
 * to `[]`, so `contacts[0].phones[1].phone` is checked as
 * `contacts[].phones[].phone`. This preserves the no-wildcards rule while
 * allowing reviewed APIs such as Service Fusion to accept nested create
 * payloads. Empty arrays/objects are rejected because they contain no leaf
 * path that policy can authorize.
 */
export function writableFieldProblems(fields: Json, allow: readonly string[]): string[] {
  const problems: string[] = [];

  // A string/number/boolean/null/array argument is already the wrong root
  // shape, and there is nothing
  // further to check key-by-key -- report it and stop rather than, say,
  // iterating an array's indices as if they were field names.
  if (fields === null || typeof fields !== "object" || Array.isArray(fields)) {
    problems.push("fields must be an object");
    return problems;
  }

  // Build the literal match set up front. A wildcard-shaped entry
  // ("*", or a trailing ".*") is not a real field name and grants nothing
  // here -- see the module doc comment for why write allowlists cannot
  // reuse the response side's wildcard semantics. It is reported as a
  // problem unconditionally, independent of whatever keys `fields` happens
  // to contain: a wildcard in a *write* allowlist is a misconfiguration
  // the moment it's written, not only once someone tries to exploit it.
  //
  // Every literal entry is compared after Unicode NFC normalization on
  // both sides (see the matching `key.normalize("NFC")` below), the same
  // way `redactArgs` in lib/audit/log.ts normalizes before comparing: two
  // strings that render identically but are encoded with different
  // combining-character sequences are indistinguishable by eye, so without
  // normalizing both sides a differently-encoded allow entry would
  // silently fail to match a visually identical field key (or vice versa).
  const literalAllow = new Set<string>();
  for (const entry of allow) {
    if (entry === "*" || entry.endsWith(".*")) {
      problems.push(
        `allowlist entry "${entry}" is not a literal field name — write allowlists must name every writable field`,
      );
      continue;
    }
    literalAllow.add(entry.normalize("NFC"));
  }

  // Walk `fields` via Object.entries -- never a bare `fields[k]` read --
  // so a key that happens to spell an Object.prototype member (`toString`,
  // `constructor`, `valueOf`, `hasOwnProperty`) is judged against the
  // allowlist as the ordinary own key it is, rather than the read silently
  // resolving through the prototype chain to a value that was never
  // actually present in the caller's JSON. Object.entries only ever
  // enumerates real own-enumerable properties, so this is safe by
  // construction and needs no separate Object.hasOwn guard for the read
  // itself (Object.hasOwn is exactly what lib/mcp/handler.ts and
  // lib/policy/grants.ts use for the equivalent concern elsewhere in this
  // codebase).
  const visit = (value: Json, path: string, rawKey = ""): void => {
    const key = rawKey || path.split(".").at(-1)?.replace(/\[\]$/u, "") || path;

    // Dots and the [] marker belong to the policy path grammar, not upstream
    // JSON property names. Refusing them as literal keys prevents a flat key
    // like "contacts.fname" from impersonating the nested path with that
    // spelling.
    if (rawKey.includes(".") || rawKey.includes("[]")) {
      problems.push(`field "${path}" is not writable`);
      return;
    }
    // No legitimate CRM property is ever named "__proto__". Unlike every
    // other key, this one is refused unconditionally -- even if an
    // allowlist author literally typed "__proto__" into an `allow` array --
    // because honoring it would hand a caller a key that, depending on how
    // some downstream adapter copies the accepted fields into a request
    // body (`out[key] = value` on a plain object literal, say), rewrites
    // that object's prototype instead of setting a property. See
    // filter.ts's `sanitize` for the read-side analogue of this same
    // hazard.
    if (key === "__proto__") {
      problems.push(`field "${path}" is not writable`);
      return;
    }

    if (Array.isArray(value)) {
      if (value.length === 0) {
        problems.push(`field "${path}" must not be an empty array`);
        return;
      }
      value.forEach((item) => visit(item, `${path}[]`));
      return;
    }

    if (value !== null && typeof value === "object") {
      const entries = Object.entries(value);
      if (entries.length === 0) {
        problems.push(`field "${path}" must not be an empty object`);
        return;
      }
      for (const [childKey, childValue] of entries) {
        visit(childValue, `${path}.${childKey}`, childKey);
      }
      return;
    }

    // Deny-by-default at the leaves: every scalar that will actually reach
    // the upstream must have one exact reviewed path in the allowlist.
    if (!literalAllow.has(path.normalize("NFC"))) {
      problems.push(`field "${path}" is not writable`);
    }
  };

  for (const [key, value] of Object.entries(fields)) {
    visit(value, key, key);
  }

  return problems;
}
