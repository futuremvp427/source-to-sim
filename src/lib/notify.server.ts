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

/** Alert kinds worth a push notification. Everything else stays in-app only. */
const IMPORTANT_KINDS = new Set([
  "new_source_trades",
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

const RETRY_AFTER_MS = 60_000;

export function telegramStatus(): TelegramStatus {
  const token = process.env["TELEGRAM_BOT_TOKEN"];
  const chat = process.env["TELEGRAM_CHAT_ID"];
  return token && chat ? "CONFIGURED" : "NOT_CONFIGURED";
}

export function isImportantAlertKind(kind: string): boolean {
  return IMPORTANT_KINDS.has(kind);
}

/**
 * Delivery is idempotent and retryable. We atomically claim a pending/failed
 * alert before transport, but notified_at is written only after Telegram has
 * actually accepted the message. A failed attempt is released back to FAILED
 * so a later scheduled cycle can retry it.
 */
export async function notifyAlert(alert: {
  id: string;
  level: string;
  kind: string;
  message: string;
}): Promise<{ sent: boolean; status: TelegramStatus | "SKIPPED" | "FAILED" }> {
  if (!isImportantAlertKind(alert.kind)) return { sent: false, status: "SKIPPED" };
  if (telegramStatus() === "NOT_CONFIGURED") return { sent: false, status: "NOT_CONFIGURED" };

  const now = new Date();
  const staleBefore = new Date(now.getTime() - RETRY_AFTER_MS).toISOString();
  const { data: claimed, error: claimError } = await supabaseAdmin
    .from("alerts")
    .update({
      notification_status: "sending",
      notification_attempted_at: now.toISOString(),
      notification_error: null,
    })
    .eq("id", alert.id)
    .is("notified_at", null)
    .or(
      `notification_status.eq.pending,notification_status.eq.failed,and(notification_status.eq.sending,notification_attempted_at.lt.${staleBefore})`,
    )
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
        disable_notification: alert.level === "info",
      }),
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) {
      await supabaseAdmin
        .from("alerts")
        .update({
          notification_status: "failed",
          notification_error: `Telegram HTTP ${res.status}`,
        })
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
      })
      .eq("id", alert.id)
      .is("notified_at", null);
    return { sent: true, status: "CONFIGURED" };
  } catch (err) {
    await supabaseAdmin
      .from("alerts")
      .update({
        notification_status: "failed",
        notification_error: err instanceof Error ? err.message.slice(0, 300) : "Telegram transport failed",
      })
      .eq("id", alert.id)
      .is("notified_at", null);
    return { sent: false, status: "FAILED" };
  }
}

/**
 * Retry a small bounded set of important alerts that previously failed (or
 * were never attempted). Intended to run once per scheduler cycle.
 */
export async function retryPendingTelegramAlerts(limit = 10): Promise<{ attempted: number; sent: number }> {
  if (telegramStatus() === "NOT_CONFIGURED") return { attempted: 0, sent: 0 };
  const retryBefore = new Date(Date.now() - RETRY_AFTER_MS).toISOString();
  const { data, error } = await supabaseAdmin
    .from("alerts")
    .select("id, level, kind, message, notification_status, notification_attempted_at")
    .is("notified_at", null)
    .or(
      `notification_status.eq.pending,notification_status.eq.failed,and(notification_status.eq.sending,notification_attempted_at.lt.${retryBefore})`,
    )
    .order("created_at", { ascending: true })
    .limit(Math.max(1, Math.min(limit, 50)));
  if (error) return { attempted: 0, sent: 0 };

  let attempted = 0;
  let sent = 0;
  for (const row of data ?? []) {
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
