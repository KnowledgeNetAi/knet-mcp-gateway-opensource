import "server-only";

// Per-process, per-IP fixed window. Resets every windowMs. It raises the bar
// on registration abuse, but each instance counts separately, so N instances
// allow N times the limit. Unused registrations are also swept after a week
// (`sweep_unused_oauth_clients`). For a hard limit across instances, back
// this with Postgres or a shared cache, or rate-limit at your load balancer.

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
