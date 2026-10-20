import type { TransportDef } from "@/lib/types";
import { UpstreamError } from "./errors";

export interface Http {
  /**
   * `opts.retryOn`, when supplied, REPLACES `transport.retry.on` for this one call — it never
   * merges with the app's config and never mutates it. This exists for writes: a mutation must
   * not be retried on a 5xx (the upstream may have already applied it — retrying would
   * double-submit), while a 429 is still safe to retry (the request was rejected, never
   * applied). Distinguish "replace with nothing" from "no override" by presence, not
   * truthiness: an explicit `retryOn: []` means retry nothing, and must not be treated the same
   * as omitting `opts` entirely and falling back to config.
   */
  request(
    url: string,
    init: RequestInit,
    opts?: { retryOn?: readonly string[] },
  ): Promise<{ status: number; data: unknown; raw: string }>;
}

/**
 * Sleep for `ms`, or reject immediately once `signal` aborts — whichever
 * comes first. Passing the caller's own AbortSignal here (for every
 * retry-backoff sleep, not the initial throttle wait) is what makes a
 * cancellation during backoff release the request promptly instead of being
 * held for the rest of the wait and then firing one more request nobody
 * wants against the shared upstream credential.
 */
function sleep(ms: number, signal?: AbortSignal | null): Promise<void> {
  if (signal?.aborted) return Promise.reject(signal.reason ?? new DOMException("This operation was aborted", "AbortError"));
  return new Promise((resolve, reject) => {
    // `{ once: true }` only removes the abort listener once "abort" actually
    // fires. On the far more common path — the timer wins, the signal never
    // aborts — nothing removes it, so a signal reused across many calls
    // (e.g. a connection-scoped signal spanning many tool calls) would
    // accumulate one stale listener per retry-backoff sleep for its whole
    // lifetime. Clean up explicitly on both paths instead.
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal?.reason ?? new DOMException("This operation was aborted", "AbortError"));
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}
const backoff = (attempt: number) => Math.min(2 ** attempt * 250, 8000);

/**
 * Sleep for `waitMs`, but only if doing so would not carry the call past `deadline` — an
 * absolute wall-clock time established once per `request()` call (Task 11 fix round 3,
 * finding F). If it would, throws a normal `UpstreamError` instead of sleeping at all.
 *
 * Task 11 fix round 4, finding I: fix round 3 folded the throttle *wait* and the fetch's own
 * timeout into the deadline, but every retry-backoff and Retry-After sleep was still a bare
 * `sleep(...)` with no deadline clamp — the ladder only ever stopped because the *next*
 * `throttle()` call refused, which meant it had already slept well past the deadline before
 * that refusal ever ran (measured: a `timeoutMs: 600` config settling at 1503ms; a
 * `Retry-After: 30` on a `timeoutMs: 500` config settling at ~30s). This is the single
 * function every backoff/Retry-After sleep in `request()` goes through, so there is exactly
 * one place a future added sleep could forget the clamp.
 *
 * Critically, this NEVER shortens `waitMs` and sleeps the reduced amount instead of throwing —
 * that would reintroduce the exact stampede `MAX_RETRY_AFTER_MS` (below) exists to prevent:
 * retrying a rate-limited upstream earlier than it explicitly asked, against the single
 * credential the whole org shares. It throws before sleeping, or it sleeps the full `waitMs`;
 * there is no third option.
 */
async function sleepWithinDeadline(
  waitMs: number,
  deadline: number,
  url: string,
  signal?: AbortSignal | null,
): Promise<void> {
  const now = Date.now();
  if (now + waitMs > deadline) {
    throw new UpstreamError(
      0,
      url,
      `deadline exceeded: a ${waitMs}ms wait would end ${now + waitMs - deadline}ms past the ${Math.max(deadline - now, 0)}ms remaining before timeout`,
    );
  }
  await sleep(waitMs, signal);
}

// The line past which we refuse to honor an upstream's requested wait and
// throw instead of retrying. This is NOT here to prevent a hang: Node's
// setTimeout silently clamps any delay above 2^31-1ms (~24.8 days) down to
// 1ms, so an uncapped "Retry-After: 999999999999" does not hang a request —
// it causes a *stampede*, retrying almost instantly while looking, from the
// code, like it waited. That is worse than a hang for an upstream with one
// account-wide credential serving a whole org: it turns a soft rate limit
// into a hard one. So a request that exceeds this cap is not capped-and-
// retried-anyway; it stops and throws.
const MAX_RETRY_AFTER_MS = 60_000;

/**
 * Parse a Retry-After header (RFC 7231) into whole seconds: either
 * delta-seconds ("120") or an HTTP-date. Returns null for anything absent,
 * non-positive, or unparseable, so the caller falls back to its own backoff
 * schedule instead of sleeping for 0ms or NaN ms.
 */
function parseRetryAfterSeconds(header: string | null): number | null {
  if (!header) return null;
  const trimmed = header.trim();
  if (!trimmed) return null;

  if (/^\d+$/.test(trimmed)) {
    const seconds = Number(trimmed);
    if (!Number.isFinite(seconds) || seconds <= 0) return null;
    return seconds;
  }

  const dateMs = Date.parse(trimmed);
  if (Number.isNaN(dateMs)) return null;
  const deltaMs = dateMs - Date.now();
  if (deltaMs <= 0) return null;
  return Math.ceil(deltaMs / 1000);
}

// However large or adversarial an error body is, only ever run the extraction
// regex against a bounded prefix. Kept as defense in depth against
// pathological input *size* (bytes processed) — independent of the match-
// bounding fix on the regex itself below, which is what actually prevents
// quadratic blowup regardless of this cap's value. Real Service Fusion error
// pages are a few KB at most.
const MAX_SUMMARY_INPUT_LENGTH = 20_000;

const NAMED_ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  nbsp: " ",
  rsquo: "’",
};

const MAX_CODE_POINT = 0x10ffff;

/**
 * `String.fromCodePoint` throws a RangeError for anything outside the valid
 * Unicode range. A hostile or merely garbled body can put an out-of-range
 * reference (`&#999999999;`, `&#x110000;`) in exactly the text we're trying
 * to report legibly, so an invalid code point is left as literal text
 * instead of decoded — never thrown.
 */
function safeFromCodePoint(codePoint: number, whole: string): string {
  return Number.isInteger(codePoint) && codePoint >= 0 && codePoint <= MAX_CODE_POINT
    ? String.fromCodePoint(codePoint)
    : whole;
}

/**
 * Decode the small set of HTML entities that show up in real error pages
 * (including numeric character references) before we scan for a sentence.
 * Without this, an escaped apostrophe like "don&#39;t" leaks raw markup
 * into what is supposed to be a decoded, human-readable message.
 */
function decodeEntities(input: string): string {
  return input
    .replace(/&(amp|lt|gt|quot|nbsp|rsquo);/gi, (whole, name: string) => NAMED_ENTITIES[name.toLowerCase()] ?? whole)
    .replace(/&#(\d+);/g, (whole, dec: string) => safeFromCodePoint(Number(dec), whole))
    .replace(/&#x([0-9a-f]+);/gi, (whole, hex: string) => safeFromCodePoint(parseInt(hex, 16), whole));
}

/** Pull the human-readable line out of an HTML error page. */
export function summarize(body: string, format: "json" | "html"): string {
  if (format === "json" || !body.trimStart().startsWith("<")) return body.slice(0, 300);

  const capped = body.length > MAX_SUMMARY_INPUT_LENGTH ? body.slice(0, MAX_SUMMARY_INPUT_LENGTH) : body;

  const text = decodeEntities(
    capped
      .replace(/<(script|style)[\s\S]*?<\/\1>/gi, " ")
      .replace(/<[^>]*>/g, " ")
      .replace(/\s+/g, " ")
      .trim()
  );

  // Look for the explanatory sentence directly. Scanning for the first
  // "interesting" line finds the "Hmmm..." heading sitting above it instead.
  // The match itself is bounded ({0,300}, not *): an unbounded `[^.]*\.` is
  // quadratic here, because a failed match at each candidate start position
  // (e.g. every repeated "It seems") rescans all the way to the end of the
  // string looking for a ".". Bounding the match keeps this linear
  // regardless of MAX_SUMMARY_INPUT_LENGTH above.
  const sentence = text.match(/\b(It seems|You (?:do not|don't) have|The requested)[^.]{0,300}\./i);
  return sentence ? sentence[0] : text.slice(0, 200);
}

export function createHttp(transport: TransportDef, fetchImpl: typeof fetch = fetch): Http {
  let lastAt = 0;

  // Earliest time the upstream's own quota allows another request, from its rate-limit
  // headers (`transport.rateLimit`). Shared by every caller of this client, like `lastAt`:
  // the quota belongs to the one credential the whole org shares, not to any single call.
  let blockedUntil = 0;

  /**
   * Record an exhausted quota window. Only `remaining === 0` with a reset inside
   * `MAX_RETRY_AFTER_MS` counts; anything absent, unparseable or larger is ignored, so a
   * garbled header degrades to the behavior without `rateLimit` rather than freezing every
   * call to this app for however long it claims.
   */
  function noteQuota(headers: Headers) {
    if (!transport.rateLimit) return;
    const remaining = headers.get(transport.rateLimit.remainingHeader)?.trim();
    const reset = headers.get(transport.rateLimit.resetHeader)?.trim();
    if (remaining !== "0" || !reset || !/^\d+$/.test(reset)) return;
    const resetMs = Number(reset) * 1000;
    if (resetMs <= 0 || resetMs > MAX_RETRY_AFTER_MS) return;
    blockedUntil = Math.max(blockedUntil, Date.now() + resetMs);
  }

  /**
   * Reserve the next throttle slot, relative to `deadline` — an absolute wall-clock time
   * (`Date.now() + transport.timeoutMs`, established once per `request()` call, before the
   * first attempt) by which this whole call, queue wait included, must either have sent its
   * request or given up.
   *
   * Task 11 fix round 3, finding F: previously this function took no deadline at all and
   * always waited out however long the reserved slot was, however far away — `timeoutMs`
   * governed only the fetch that came after, never the wait before it. Restoring the
   * memoized, long-lived `Http` client per (org, app) (fix round 2, finding A) made the
   * throttle's queueing real again in production, which is exactly what makes an unbounded
   * wait here dangerous: Contoso's single account-wide Service Fusion credential, hit by
   * an LLM client fanning out N parallel tool calls at `minIntervalMs:600`, would otherwise
   * queue the Nth caller for `N * 600`ms with nothing capping N and nothing telling the
   * caller its own configured `timeoutMs` had long since become meaningless.
   *
   * If the reserved slot falls beyond `deadline`, this call fails fast — throwing a normal
   * `UpstreamError` (status 0, so `lib/mcp/handler.ts`'s `failureClass` reports it as
   * `gateway_error`, and the handler still writes its one audit row) — instead of joining the
   * queue at all. Deliberately does NOT commit `lastAt = at` in that case: this call will never
   * reach the upstream, so it must not claim a slot in the shared timeline that some other,
   * still-viable caller could otherwise use — the shared credential's pacing is exactly as if
   * this call had never been made.
   *
   * Reserve the next slot synchronously, before any await, in the branch that does proceed. If
   * this read the current `lastAt`, awaited, and only then wrote it back, every concurrent
   * caller would read the same stale value and the spacing would collapse to a no-op after the
   * first tick — exactly the failure mode this throttle exists to prevent for a shared,
   * account-wide credential under concurrent gateway calls.
   */
  async function throttle(deadline: number, url: string) {
    const now = Date.now();
    const at = Math.max(now, lastAt + transport.minIntervalMs, blockedUntil);
    if (at > deadline) {
      throw new UpstreamError(
        0,
        url,
        `throttled: next available slot is ${at - now}ms away, exceeding the ${Math.max(deadline - now, 0)}ms remaining before timeout`,
      );
    }
    lastAt = at;
    if (at > now) await sleep(at - now);
  }

  return {
    async request(url, init, opts) {
      // Normalize case so a config typo like "5XX" or "TRUNCATED" still
      // matches — these tokens are free-form strings in TransportDef, not a
      // literal union, so nothing else enforces their casing. The same
      // normalization applies whether the list comes from config or from a
      // caller-supplied override, for the same reason.
      //
      // Branch on presence (`!== undefined`), not truthiness: a caller
      // passing `retryOn: []` means "retry nothing for this call" and must
      // not silently fall back to `transport.retry.on` just because the
      // array is empty. Reading from `opts?.retryOn` rather than assigning
      // into `transport.retry.on` also guarantees the app's shared config
      // object is never mutated by a single call's override.
      const retryOn = new Set(
        (opts?.retryOn !== undefined ? opts.retryOn : transport.retry.on).map((t) => t.toLowerCase()),
      );
      const attempts = transport.retry.attempts;

      // Established once, before the first throttle wait, and shared across every
      // attempt/retry/backoff this call makes (Task 11 fix round 3, finding F) — "this call
      // may take this long" was always meant to cover the whole call, queueing included, not
      // just whichever individual fetch happens to run last.
      const deadline = Date.now() + transport.timeoutMs;

      for (let attempt = 1; attempt <= attempts; attempt++) {
        await throttle(deadline, url);
        const last = attempt === attempts;

        // However little of the budget the queue wait (or a previous attempt's backoff) left,
        // the fetch gets exactly that much — never a fresh full `timeoutMs`. If nothing is
        // left, fail fast the same way `throttle` does above, rather than handing
        // `AbortSignal.timeout` a zero/negative delay.
        const remaining = deadline - Date.now();
        if (remaining <= 0) {
          throw new UpstreamError(0, url, "deadline exceeded before request could be sent");
        }

        let res: Response;
        try {
          // Merge the caller's own AbortSignal (if any) with the per-attempt
          // timeout instead of overwriting it — otherwise a caller has no way
          // to cancel an in-flight request (e.g. its MCP client disconnected).
          const signal = init.signal
            ? AbortSignal.any([init.signal, AbortSignal.timeout(remaining)])
            : AbortSignal.timeout(remaining);
          res = await fetchImpl(url, { ...init, signal });
        } catch (err) {
          // The caller cancelled (e.g. its MCP client disconnected) — this
          // must never be retried. Retrying would hold the request open
          // through the full backoff ladder for something nobody wants
          // anymore (defeating the point of merging the caller's signal in
          // the first place), and reporting it as an UpstreamError would
          // misrepresent a cancellation as an upstream failure. This check
          // must come before the timeout/network check below, because a
          // caller abort also surfaces with `err.name === "AbortError"` and
          // would otherwise be treated as transient and retried.
          if (init.signal?.aborted) {
            throw err;
          }

          // Only a genuine per-attempt timeout or network failure is
          // transient and worth retrying. Anything else — a bad URL, a bad
          // RequestInit, some other programming error — is not, and burning
          // every attempt's backoff on it while reporting it as an
          // UpstreamError would both waste time and destroy its real type
          // and stack. So: rethrow anything that isn't recognizably a
          // timeout/abort or a network failure (undici surfaces the latter
          // as a TypeError with a populated `.cause`).
          if (!(err instanceof Error) || !(err.name === "TimeoutError" || err.name === "AbortError" || err.cause !== undefined)) {
            throw err;
          }
          if (last) {
            throw new UpstreamError(0, url, `request timed out or failed: ${err.message}`, { cause: err });
          }
          await sleepWithinDeadline(backoff(attempt), deadline, url, init.signal);
          continue;
        }

        noteQuota(res.headers);
        const raw = await res.text();

        if ((res.status === 429 && retryOn.has("429")) ||
            (res.status >= 500 && retryOn.has("5xx"))) {
          if (last) throw new UpstreamError(res.status, url, summarize(raw, transport.errors.format));

          if (transport.retry.respectRetryAfter) {
            const seconds = parseRetryAfterSeconds(res.headers.get("retry-after"));
            if (seconds !== null) {
              if (seconds * 1000 > MAX_RETRY_AFTER_MS) {
                // Retrying early would ignore what the upstream explicitly
                // asked for, against the single credential serving the whole
                // org — that's how a soft rate limit becomes a hard one.
                // Stop instead of guessing.
                throw new UpstreamError(res.status, url, `rate limited; upstream asked for ${seconds}s`);
              }
              await sleepWithinDeadline(seconds * 1000, deadline, url, init.signal);
              continue;
            }
          }

          // No Retry-After, but the quota headers say when the window resets: wait for that,
          // not the backoff ladder, which would spend the remaining attempts inside the same
          // exhausted window.
          if (res.status === 429 && blockedUntil > Date.now()) {
            await sleepWithinDeadline(blockedUntil - Date.now(), deadline, url, init.signal);
            continue;
          }

          await sleepWithinDeadline(backoff(attempt), deadline, url, init.signal);
          continue;
        }

        if (!res.ok) {
          throw new UpstreamError(res.status, url, summarize(raw, transport.errors.format));
        }

        if (raw.length === 0) {
          // 204/205 legitimately carry no body. Any other status with a
          // zero-byte body is the most complete truncation there is — a
          // connection cut before the first byte arrived — and must not be
          // reported as "no data": a caller doing `data.items ?? []` would
          // silently see an empty result set from a failed request.
          if (res.status === 204 || res.status === 205) {
            return { status: res.status, data: null, raw };
          }
          if (last || !retryOn.has("truncated")) {
            throw new UpstreamError(res.status, url, "truncated response body (0 bytes)");
          }
          await sleepWithinDeadline(backoff(attempt), deadline, url, init.signal);
          continue;
        }

        try {
          return { status: res.status, data: JSON.parse(raw), raw };
        } catch {
          // A 2xx body that will not parse means the response was cut short.
          // Returning it as empty would silently truncate a caller's results.
          if (last || !retryOn.has("truncated")) {
            throw new UpstreamError(res.status, url, `truncated response body (${raw.length} bytes)`);
          }
          await sleepWithinDeadline(backoff(attempt), deadline, url, init.signal);
        }
      }

      // Unreachable in practice: every branch above either returns or throws
      // once `last` is true, and `last` is true on the final loop iteration.
      // Kept only so the function has an explicit, type-checkable return path
      // for every code path (and as a safety net for attempts <= 0).
      throw new UpstreamError(0, url, `exhausted ${attempts} attempts`);
    },
  };
}
