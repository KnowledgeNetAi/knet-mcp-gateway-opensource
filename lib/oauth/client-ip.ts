import type { NextRequest } from "next/server";

/**
 * The rightmost `X-Forwarded-For` entry: the address the nearest proxy (the
 * platform's load balancer) appended. Everything to its left is whatever the
 * client chose to send, so keying the rate limit on the leftmost entry let a
 * caller pick a new bucket per request. Behind more than one proxy of your
 * own, adjust this to skip them.
 */
export function clientIp(req: NextRequest): string {
  const hops = req.headers.get("x-forwarded-for")?.split(",").map((h) => h.trim()).filter(Boolean);
  return hops?.at(-1) ?? req.headers.get("x-real-ip") ?? "unknown";
}
