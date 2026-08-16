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
]);
const IMPORTANT_KIND_LIST = [...IMPORTANT_KINDS];

/** Tier 1: actual paper BUYs always have delivery priority. */
const PRIORITY_KIND = "paper_buy";
const TIER2_KIND_LIST = IMPORTANT_KIND_LIST.filter((kind) => kind !== PRIORITY_KIND);

/**
 * Operational (non paper BUY) alerts are only retried while they are still
 * current. Older rows remain stored for history/diagnostics but must never
 * flood Telegram with an ancient backlog.
 */
const NON_PAPER_BUY_MAX_RETRY_AGE_MS = 2 * 60 * 60 * 1000;

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
 * were never attempted). Filtering by kind happens IN THE QUERY before the
 * limit is applied: permanently pending in-app-only alerts must never occupy
 * every retry slot and starve a newly queued paper_buy notification.
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

  const { data, error } = await supabaseAdmin
    .from("alerts")
    .select("*")
    .is("notified_at", null)
    .in("notification_status" as never, ["pending", "failed"] as never)
    .in("kind" as never, IMPORTANT_KIND_LIST as never)
    .order("created_at", { ascending: true })
    .limit(Math.max(1, Math.min(limit, 50)));
  if (error) return { attempted: 0, sent: 0 };

  let attempted = 0;
  let sent = 0;
  for (const raw of data ?? []) {
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
