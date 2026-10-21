/**
 * A post-sign-in destination taken from a `next` parameter, reduced to a path
 * on this origin. Returns `fallback` for anything else.
 *
 * Prefix checks alone are not enough: a browser drops tabs and newlines from
 * a URL before parsing it, so "/\t/evil.example" passes a "starts with //"
 * test and then navigates to evil.example. Parsing against a placeholder
 * origin and requiring that origin back catches every such spelling.
 */
export function safeNextPath(next: string | null | undefined, fallback: string): string {
  if (!next || !next.startsWith("/")) return fallback;
  if (/[\u0000-\u001f\u007f\\]/.test(next)) return fallback;
  let url: URL;
  try {
    url = new URL(next, "https://placeholder.invalid");
  } catch {
    return fallback;
  }
  if (url.origin !== "https://placeholder.invalid") return fallback;
  // Dot segments can normalize "/..//x" to "//x", which is protocol-relative.
  if (url.pathname.startsWith("//")) return fallback;
  return `${url.pathname}${url.search}${url.hash}`;
}
