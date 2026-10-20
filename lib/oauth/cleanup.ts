import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";

/**
 * Opportunistic sweep of stale `oauth_authorization_codes` rows.
 *
 * Spec §6, "Authorization codes accumulating": the reference implementation hangs the
 * equivalent off a worker daemon; the gateway has none, and a table whose
 * rows carry a 60-second TTL (`AUTH_CODE_TTL_MS` in lib/oauth/codes.ts)
 * doesn't justify standing up Cloud Scheduler for it. Instead this is called
 * fire-and-forget from `app/oauth/token/route.ts` after a successful
 * exchange, wrapped there in `void sweep(...).catch(() => {})` -- a sweep
 * failure must never fail a token exchange.
 *
 * "Sampled": rather than running the DELETE on every token exchange, each
 * call only has a small chance of actually issuing it, so a burst of
 * token-exchange traffic never turns this into extra load on the hot path.
 */
const SAMPLE_RATE = 0.02;

// Codes have a 60-second TTL and are single-use (consumed_at is set on first
// exchange), so 24h is a wide safety margin -- nothing legitimate is ever
// this old.
const STALE_AFTER_MS = 24 * 60 * 60 * 1000;

export async function sweepExpiredCodes(supabase: SupabaseClient): Promise<void> {
  if (Math.random() >= SAMPLE_RATE) return;

  const cutoff = new Date(Date.now() - STALE_AFTER_MS).toISOString();
  const { error } = await supabase
    .from("oauth_authorization_codes")
    .delete()
    .or(`expires_at.lt.${cutoff},consumed_at.lt.${cutoff}`);
  if (error) throw new Error(`sweepExpiredCodes: ${error.message}`);
}
