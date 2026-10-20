import "server-only";

// Per-process, per-IP token bucket. Resets every windowMs. Adequate for
// raising the bar on DCR abuse on a single Vercel instance; not a
// distributed limiter. If we ever care about cross-instance limits, swap to
// Postgres or a KV.

type Bucket = { count: number; windowStart: number };

const buckets = new Map<string, Bucket>();

export function rateLimit(
  key: string,
  limit: number,
  windowMs: number,
): { allowed: boolean; retryAfterSec: number } {
  const now = Date.now();
  const bucket = buckets.get(key);
  if (!bucket || now - bucket.windowStart > windowMs) {
    buckets.set(key, { count: 1, windowStart: now });
    return { allowed: true, retryAfterSec: 0 };
  }
  if (bucket.count >= limit) {
    return {
      allowed: false,
      retryAfterSec: Math.ceil((bucket.windowStart + windowMs - now) / 1000),
    };
  }
  bucket.count += 1;
  return { allowed: true, retryAfterSec: 0 };
}
