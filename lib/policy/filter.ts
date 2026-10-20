import type { Json } from "@/lib/types";
import { matchesPath, isPrefixOfPath } from "./paths";

/**
 * Prune `value` to the paths `allow` selects.
 *
 * Deny-by-default: anything not selected is dropped, so a field added upstream
 * is invisible until someone edits roles.json and a human reviews it.
 *
 * The walk threads the path as `string[]` segments — one per actual object
 * key, never split on "." — so a vendor key that itself contains a literal
 * dot is always exactly one segment and can never be split into (or matched
 * against) multiple pattern segments. See `matchesPath` / `isPrefixOfPath`.
 */
export function filterFields(value: Json, allow: string[]): Json {
  if (allow.includes("*")) return value;
  const pruned = prune(value, [], allow);
  return pruned === undefined ? (Array.isArray(value) ? [] : {}) : pruned;
}

/**
 * Deep-copy `value`, dropping any object key literally named "__proto__" at
 * every level.
 *
 * Used only where a whole subtree is granted (the allow-matched branch of
 * `prune` below), because that branch pushes the upstream value straight
 * into the output instead of walking it key-by-key — so the per-key
 * `key === "__proto__"` skip below never runs for anything nested inside a
 * granted subtree. Without this, a vendor key named "__proto__" anywhere
 * inside a granted subtree (e.g. under a common `"locations.*"`-style grant)
 * would carry the same prototype-pollution hazard into the output that the
 * rest of this module drops explicitly.
 *
 * A `JSON.parse(JSON.stringify(value))` round-trip does NOT fix this:
 * `JSON.stringify` emits a `"__proto__"` own key and `JSON.parse` recreates
 * it as an own property, so the hazard survives the round-trip unchanged.
 * Hence the explicit recursive walk here.
 */
function sanitize(value: Json): Json {
  if (Array.isArray(value)) {
    return value.map(sanitize);
  }
  if (value !== null && typeof value === "object") {
    const entries: [string, Json][] = [];
    for (const [key, child] of Object.entries(value)) {
      if (key === "__proto__") continue;
      entries.push([key, sanitize(child)]);
    }
    return Object.fromEntries(entries);
  }
  return value;
}

function prune(value: Json, path: string[], allow: string[]): Json | undefined {
  // Arrays are transparent: every element carries the same path as the array.
  if (Array.isArray(value)) {
    const items = value.map((v) => prune(v, path, allow)).filter((v) => v !== undefined) as Json[];
    return items.length > 0 ? items : undefined;
  }

  if (value !== null && typeof value === "object") {
    // Built via Object.fromEntries rather than assigning onto a `{}` literal:
    // an upstream JSON response can legitimately carry an own-enumerable key
    // literally named "__proto__" (JSON.parse creates it safely), and
    // `out[key] = child` for such a key would invoke Object.prototype's
    // special __proto__ setter instead of creating a normal property,
    // silently replacing this object's prototype rather than storing the
    // value. Object.fromEntries always creates a real own property.
    const entries: [string, Json][] = [];
    for (const [key, child] of Object.entries(value)) {
      // No legitimate allowlist can ever name "__proto__" (it is not a real
      // field), so drop it unconditionally instead of letting it reach
      // Object.fromEntries. Object.fromEntries itself creates a safe own
      // property for that key, but a poisoned-but-inert "__proto__" key
      // surviving into the *output* would still re-trigger the original
      // corruption in any downstream consumer that copies the result with
      // `Object.assign({}, filtered)` or a `for (const k of Object.keys(...))`
      // loop that assigns by key. Dropping it here removes the hazard
      // instead of merely relocating it one frame outward.
      if (key === "__proto__") continue;

      const childPath = [...path, key];

      // Whole subtree selected ONLY when the allow entry itself asks for one
      // — a bare "*" or a trailing ".*". (B1, Task 12 final review.) An
      // *exact* (non-wildcard) pattern that happens to match this path names
      // one field, not "this field and everything nested under it": treating
      // an exact match as a subtree grant meant upstream schema drift
      // (a field that used to be a string turning into an object, or gaining
      // a new nested key) came through completely unfiltered the moment any
      // exact leaf-shaped allow entry happened to match its new container —
      // reachable through the committed config as shipped (bookkeeper's
      // `invoice_*.allow` contains the bare entries "customer" and "terms").
      // Deny-by-default has to fail closed on drift, not just on an
      // unmatched key.
      if (allow.some((p) => (p === "*" || p.endsWith(".*")) && matchesPath(childPath, p))) {
        // Whole subtree selected: sanitize rather than push `child` by
        // reference, so a "__proto__" key nested anywhere inside it (at any
        // depth) is dropped instead of surviving into the output. This also
        // means the granted subtree is a copy, not an alias of the upstream
        // response — a deliberate side effect, not an accident.
        entries.push([key, sanitize(child)]);
        continue;
      }
      // Otherwise descend: an exact pattern that matches childPath exactly
      // still reaches this branch instead of the subtree grant above, so a
      // primitive value at that path is kept (prune's own base case
      // re-checks the exact pattern against childPath) while an object/array
      // that has drifted in from upstream only keeps whatever grandchildren
      // some allow entry separately names — never the whole thing.
      if (allow.some((p) => matchesPath(childPath, p) || isPrefixOfPath(childPath, p))) {
        const kept = prune(child, childPath, allow);
        if (kept !== undefined) entries.push([key, kept]);
      }
    }
    return entries.length > 0 ? Object.fromEntries(entries) : undefined;
  }

  return allow.some((p) => matchesPath(path, p)) ? value : undefined;
}
