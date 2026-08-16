/**
 * SERVER-ONLY shared host-level rate-limit cooldown.
 *
 * Phase 1 of the data-api.polymarket.com 429 incident deduplicated identical
 * /trades requests within a single runIngestCycle invocation, but a fresh
 * scheduler tick has no memory of the previous one -- a 429 seen on tick N
 * was independently rediscovered by every experiment on tick N+1, N+2, and
 * so on, because nothing paced requests *across* ticks. This module gives
 * every caller (V2/V3 ingestion and General Shadow alike, since both hit the
 * same upstream host) a durable, host-scoped cooldown backed by one row in
 * Postgres: the first 429 observed anywhere records a short blocked_until,
 * and every caller checks it before touching the host again, instead of
 * each one rediscovering the limit on its own.
 *
 * Deliberately the smallest existing durable coordination mechanism in this
 * repo, not a new subsystem: one row per host, written with an atomic
 * GREATEST-upsert RPC that mirrors the acquire_worker_lease pattern already
 * used for lease fencing.
 */

import { supabaseAdmin } from "@/integrations/supabase/client.server";

export const DATA_API_HOST = "data-api.polymarket.com";

const MIN_COOLDOWN_MS = 60_000;
const DEFAULT_COOLDOWN_MS = 90_000;
const MAX_COOLDOWN_MS = 600_000;

/**
 * Parses a Retry-After header (either delay-seconds or an HTTP-date, per
 * RFC 9110 10.2.3) into a millisecond wait. Returns null when absent or
 * unparseable so the caller falls back to its own default.
 */
export function parseRetryAfterMs(value: string | null, now: number = Date.now()): number | null {
  if (!value) return null;
  const seconds = Number(value);
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);
  const when = Date.parse(value);
  if (Number.isFinite(when)) return Math.max(0, when - now);
  return null;
}

/**
 * Clamps a candidate cooldown duration into [MIN_COOLDOWN_MS,
 * MAX_COOLDOWN_MS]. A missing Retry-After falls back to DEFAULT_COOLDOWN_MS
 * before clamping; a present-but-pathological Retry-After (absurdly long, or
 * zero/negative) is still bounded, so one bad header value can never lock
 * ingestion out indefinitely or fail to pace it at all.
 */
export function clampCooldownMs(candidateMs: number | null): number {
  const base = candidateMs ?? DEFAULT_COOLDOWN_MS;
  return Math.min(MAX_COOLDOWN_MS, Math.max(MIN_COOLDOWN_MS, base));
}

export type HostCooldown = {
  blocked: boolean;
  until: Date | null;
  reason: string | null;
};

/**
 * Reads the current cooldown for a host. Fails CLOSED: if the read itself
 * cannot be trusted (a query error, a thrown exception), the caller treats
 * the host as blocked rather than risk hammering an upstream that may
 * already be rate-limiting this application. The cost of deferring one
 * scheduler cycle is far lower than the cost of amplifying a live 429 storm.
 */
export async function getHostCooldown(host: string): Promise<HostCooldown> {
  try {
    // Cast: http_rate_limits is defined in this session's migration;
    // generated Supabase types are refreshed only after the migration is
    // applied (same pattern as record_http_rate_limit's RPC cast below).
    const { data, error } = await supabaseAdmin
      .from("http_rate_limits" as never)
      .select("blocked_until, reason")
      .eq("host", host)
      .maybeSingle();
    if (error) {
      return { blocked: true, until: null, reason: `cooldown state unreadable: ${error.message}` };
    }
    const row = data as { blocked_until: string | null; reason: string | null } | null;
    const until = row?.blocked_until ? new Date(row.blocked_until) : null;
    const blocked = until !== null && until.getTime() > Date.now();
    return {
      blocked,
      until: blocked ? until : null,
      reason: blocked ? (row?.reason ?? null) : null,
    };
  } catch (err) {
    return {
      blocked: true,
      until: null,
      reason: `cooldown state unreadable: ${err instanceof Error ? err.message : "unknown error"}`,
    };
  }
}

/**
 * Records (extends, never shortens) a cooldown for a host after observing a
 * 429. Best-effort: a failure to WRITE the cooldown must never crash or
 * delay the caller's own error path -- the request that triggered this has
 * already failed regardless; the cooldown only paces the *next* attempt.
 */
export async function recordHostRateLimit(
  host: string,
  retryAfterMs: number | null,
): Promise<void> {
  const durationMs = clampCooldownMs(retryAfterMs);
  const until = new Date(Date.now() + durationMs).toISOString();
  try {
    // Cast: record_http_rate_limit is defined in this session's migration;
    // generated Supabase types are refreshed only after the migration is
    // applied (same pattern as release_reconcile_lease in shadow.server.ts).
    await supabaseAdmin.rpc(
      "record_http_rate_limit" as never,
      {
        p_host: host,
        p_blocked_until: until,
        p_reason:
          retryAfterMs !== null ? `Retry-After ${retryAfterMs}ms` : "429 without Retry-After",
      } as never,
    );
  } catch {
    // Best-effort only -- see doc comment above.
  }
}

/** Test-only aliases so the cooldown constants can be asserted directly. */
export const MIN_COOLDOWN_MS_FOR_TEST = MIN_COOLDOWN_MS;
export const DEFAULT_COOLDOWN_MS_FOR_TEST = DEFAULT_COOLDOWN_MS;
export const MAX_COOLDOWN_MS_FOR_TEST = MAX_COOLDOWN_MS;
