/**
 * SERVER-ONLY Telegram notification adapter.
 *
 * Small by design: it only reads two secrets inside the call, posts a message
 * and reports status. Secrets never reach the browser and are never logged.
 * When either secret is missing the status is NOT_CONFIGURED and the bot keeps
 * running normally.
 */

import { supabaseAdmin } from "@/integrations/supabase/client.server";

export type TelegramStatus = "NOT_CONFIGURED" | "CONFIGURED";

/**
 * Alert kinds worth a push notification. Everything else stays in-app only.
 * new_source_trades is deliberately absent: those rows stay in the database for
 * the dashboard, but source-trade volume is not actionable over Telegram.
 */
const IMPORTANT_KINDS = new Set([
  "paper_buy",
  "paper_sell",
  "LOW_SPENDABLE_CASH",
  "CASH_RESERVE_REACHED",
  "settlement_verified",
  "settlement",
  "position_settled",
  "reconciliation_mismatch",
  "reconciliation_incomplete",
  "poll_failure",
  "pmus_exact_match",
  "us_exact_match",
  // Sports Forward Shadow -- actionable-only (never per-trade fills). See
  // sports-shadow/alerts.server.ts's raiseAlert/raiseMilestoneAlert for the two call
  // sites that emit these: a fresh (not-already-active) operational condition, and a
  // one-time-per-epoch milestone.
  "sports_shadow_source_unhealthy",
  "sports_shadow_source_coverage_gap",
  "sports_shadow_venue_starved",
  "sports_shadow_rate_limit_storm",
  "sports_shadow_observation_backlog",
  "sports_shadow_integrity_failed",
  "sports_shadow_settlement_stuck",
  "sports_shadow_scheduler_stopped",
  "sports_shadow_soak_passed",
  "sports_shadow_soak_failed",
  "sports_shadow_calibration_100",
  "sports_shadow_oos_300",
  "sports_shadow_live_pilot_review_ready",
]);
const IMPORTANT_KIND_LIST = [...IMPORTANT_KINDS];

/** Tier 1: actual paper BUYs always have delivery priority. */
const PRIORITY_KIND = "paper_buy";

/**
 * RETRY CUTOVER — the actual hardening deployment boundary (commit 66bc02d,
 * 2026-08-16T20:26:30Z).
 *
 * Every alert created before this instant (including the never-delivered
 * Aug 14-15 settlement alerts) stays stored for history/diagnostics and is
 * never deleted, but is NOT a retry candidate: replaying that backlog would
 * blast the chat with historical noise. Only alerts created at/after this
 * instant participate in retry, which is what makes durable (no expiry) retry
 * semantics safe for future actionable kinds.
 */
export const TELEGRAM_RETRY_CUTOVER_AT = "2026-08-16T20:26:30.000Z";

/**
 * Durable kinds: genuinely actionable, low volume. After the cutover these stay
 * retryable indefinitely (at-least-once), with no freshness expiry.
 */
const DURABLE_KINDS = new Set([
  "paper_buy",
  "paper_sell",
  "position_settled",
  "settlement",
  "settlement_verified",
  "LOW_SPENDABLE_CASH",
  "CASH_RESERVE_REACHED",
  "pmus_exact_match",
  "us_exact_match",
  // Sports Forward Shadow: all low-volume by construction (operational conditions are
  // raised only on a fresh activation, never repeated while sustained; milestones fire
  // at most once ever per epoch) -- durable, indefinite retry is safe and desired.
  "sports_shadow_source_unhealthy",
  "sports_shadow_source_coverage_gap",
  "sports_shadow_venue_starved",
  "sports_shadow_rate_limit_storm",
  "sports_shadow_observation_backlog",
  "sports_shadow_integrity_failed",
  "sports_shadow_settlement_stuck",
  "sports_shadow_scheduler_stopped",
  "sports_shadow_soak_passed",
  "sports_shadow_soak_failed",
  "sports_shadow_calibration_100",
  "sports_shadow_oos_300",
  "sports_shadow_live_pilot_review_ready",
]);

/** Tier 2a: durable kinds other than the tier-1 priority kind. */
const DURABLE_TIER2_KIND_LIST = [...DURABLE_KINDS].filter((kind) => kind !== PRIORITY_KIND);

/**
 * High-volume operational diagnostics (poll/reconciliation noise). Only useful
 * while current, so they stay bounded to the short freshness window below.
 */
const OPERATIONAL_KIND_LIST = IMPORTANT_KIND_LIST.filter((kind) => !DURABLE_KINDS.has(kind));

export function isDurableAlertKind(kind: string): boolean {
  return DURABLE_KINDS.has(kind);
}

/**
 * Operational alerts are only retried while they are still current. Older rows
 * remain stored for history/diagnostics but never flood Telegram.
 */
const NON_PAPER_BUY_MAX_RETRY_AGE_MS = 2 * 60 * 60 * 1000;

/** The oldest created_at a retry candidate of the given class may have. */
export function retryFloorIso(kind: "durable" | "operational", now = Date.now()): string {
  const cutover = new Date(TELEGRAM_RETRY_CUTOVER_AT).getTime();
  if (kind === "durable") return new Date(cutover).toISOString();
  return new Date(Math.max(cutover, now - NON_PAPER_BUY_MAX_RETRY_AGE_MS)).toISOString();
}

const RETRY_AFTER_MS = 60_000;

export function telegramStatus(): TelegramStatus {
  const token = process.env["TELEGRAM_BOT_TOKEN"];
  const chat = process.env["TELEGRAM_CHAT_ID"];
  return token && chat ? "CONFIGURED" : "NOT_CONFIGURED";
}

export function isImportantAlertKind(kind: string): boolean {
  return IMPORTANT_KINDS.has(kind);
}

/** Actual paper BUYs are actionable and deliberately arrive as normal pushes. */
export function shouldDisableTelegramNotification(level: string, kind: string): boolean {
  return level === "info" && kind !== "paper_buy";
}

/**
 * Delivery is at-least-once, not exactly-once — this is a known, accepted
 * limitation of the claim-then-send design, not something closed here. The
 * claim step (pending/failed -> sending) is atomic, so two workers can never
 * both attempt the same alert concurrently. But a crash after Telegram
 * accepts the message and before the notified_at commit lands leaves the row
 * claimable again (via the stale-sending sweep in retryPendingTelegramAlerts,
 * or a fresh process), so the SAME message can be sent to Telegram more than
 * once. Closing that window would need a transactional outbox or an
 * idempotency key on the Telegram side; neither exists here.
 *
 * New migration columns are cast at the write boundary because the generated
 * Supabase types are refreshed by Lovable only after the migration is applied.
 */
export async function notifyAlert(alert: {
  id: string;
  level: string;
  kind: string;
  message: string;
}): Promise<{ sent: boolean; status: TelegramStatus | "SKIPPED" | "FAILED" }> {
  if (!isImportantAlertKind(alert.kind)) return { sent: false, status: "SKIPPED" };
  if (telegramStatus() === "NOT_CONFIGURED") return { sent: false, status: "NOT_CONFIGURED" };

  const { data: claimed, error: claimError } = await supabaseAdmin
    .from("alerts")
    .update({
      notification_status: "sending",
      notification_attempted_at: new Date().toISOString(),
      notification_error: null,
    } as never)
    .eq("id", alert.id)
    .is("notified_at", null)
    .in("notification_status" as never, ["pending", "failed"] as never)
    .select("id");
  if (claimError || !claimed?.length) return { sent: false, status: "SKIPPED" };

  const token = process.env["TELEGRAM_BOT_TOKEN"]!;
  const chatId = process.env["TELEGRAM_CHAT_ID"]!;
  try {
    const res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        chat_id: chatId,
        text: `[${alert.level.toUpperCase()}] ${alert.kind}\n${alert.message}`,
        disable_notification: shouldDisableTelegramNotification(alert.level, alert.kind),
      }),
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) {
      await supabaseAdmin
        .from("alerts")
        .update({
          notification_status: "failed",
          notification_error: `Telegram HTTP ${res.status}`,
        } as never)
        .eq("id", alert.id)
        .is("notified_at", null);
      return { sent: false, status: "FAILED" };
    }
    await supabaseAdmin
      .from("alerts")
      .update({
        notified_at: new Date().toISOString(),
        notification_status: "sent",
        notification_error: null,
      } as never)
      .eq("id", alert.id)
      .is("notified_at", null);
    return { sent: true, status: "CONFIGURED" };
  } catch (err) {
    await supabaseAdmin
      .from("alerts")
      .update({
        notification_status: "failed",
        notification_error: err instanceof Error ? err.message.slice(0, 300) : "Telegram transport failed",
      } as never)
      .eq("id", alert.id)
      .is("notified_at", null);
    return { sent: false, status: "FAILED" };
  }
}

/**
 * Retry a small bounded set of important alerts that previously failed (or
 * were never attempted), using a strict two-tier priority policy.
 *
 * TIER 1 — actual paper BUYs, oldest first (FIFO), selected before any other
 * kind is even queried. No other alert can occupy a slot ahead of a pending
 * paper_buy.
 * TIER 2a — other DURABLE_KINDS (settlement / cash / paper sell): retryable
 * indefinitely after the cutover, newest first.
 * TIER 2b — high-volume operational diagnostics, only within
 * NON_PAPER_BUY_MAX_RETRY_AGE_MS.
 *
 * Every tier is floored at TELEGRAM_RETRY_CUTOVER_AT, so the pre-hardening
 * backlog is never replayed while remaining stored.
 *
 * `limit` is a TOTAL budget across both tiers. Nothing is ever deleted here:
 * alerts outside their window simply stop being retry candidates.
 */
export async function retryPendingTelegramAlerts(limit = 10): Promise<{ attempted: number; sent: number }> {
  if (telegramStatus() === "NOT_CONFIGURED") return { attempted: 0, sent: 0 };
  const retryBefore = new Date(Date.now() - RETRY_AFTER_MS).toISOString();

  // Recover a claim abandoned by a crashed invocation.
  await supabaseAdmin
    .from("alerts")
    .update({ notification_status: "failed", notification_error: "stale notification claim" } as never)
    .is("notified_at", null)
    .eq("notification_status" as never, "sending" as never)
    .lt("notification_attempted_at" as never, retryBefore as never);

  const total = Math.max(1, Math.min(limit, 50));

  const { data: priority, error: priorityError } = await supabaseAdmin
    .from("alerts")
    .select("*")
    .is("notified_at", null)
    .in("notification_status" as never, ["pending", "failed"] as never)
    .eq("kind" as never, PRIORITY_KIND as never)
    .gte("created_at" as never, retryFloorIso("durable") as never)
    .order("created_at", { ascending: true })
    .limit(total);
  if (priorityError) return { attempted: 0, sent: 0 };

  const priorityRows = priority ?? [];
  const otherRows: typeof priorityRows = [];

  const tiers: { kinds: string[]; floor: string }[] = [
    { kinds: DURABLE_TIER2_KIND_LIST, floor: retryFloorIso("durable") },
    { kinds: OPERATIONAL_KIND_LIST, floor: retryFloorIso("operational") },
  ];
  for (const tier of tiers) {
    const remaining = total - priorityRows.length - otherRows.length;
    if (remaining <= 0 || tier.kinds.length === 0) break;
    const { data: others, error: othersError } = await supabaseAdmin
      .from("alerts")
      .select("*")
      .is("notified_at", null)
      .in("notification_status" as never, ["pending", "failed"] as never)
      .in("kind" as never, tier.kinds as never)
      .gte("created_at" as never, tier.floor as never)
      .order("created_at", { ascending: false })
      .limit(remaining);
    if (othersError) return { attempted: 0, sent: 0 };
    otherRows.push(...((others ?? []) as typeof priorityRows));
  }

  const data = [...priorityRows, ...otherRows].slice(0, total);

  let attempted = 0;
  let sent = 0;
  for (const raw of data) {
    const row = raw as typeof raw & { notification_status?: string | null };
    // Defense-in-depth in case storage/query semantics ever drift; the DB
    // filter above is the load-bearing anti-starvation fix.
    if (!isImportantAlertKind(String(row.kind))) continue;
    attempted += 1;
    const result = await notifyAlert({
      id: String(row.id),
      level: String(row.level),
      kind: String(row.kind),
      message: String(row.message),
    });
    if (result.sent) sent += 1;
  }
  return { attempted, sent };
}
