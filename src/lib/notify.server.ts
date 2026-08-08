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
  "reconciliation_mismatch",
  "poll_failure",
  "pmus_exact_match",
  "us_exact_match",
]);

export function telegramStatus(): TelegramStatus {
  const token = process.env["TELEGRAM_BOT_TOKEN"];
  const chat = process.env["TELEGRAM_CHAT_ID"];
  return token && chat ? "CONFIGURED" : "NOT_CONFIGURED";
}

export function isImportantAlertKind(kind: string): boolean {
  return IMPORTANT_KINDS.has(kind);
}

/**
 * Delivery is idempotent: notified_at is claimed with a conditional update, so
 * a given alert row can only ever produce one Telegram message.
 */
export async function notifyAlert(alert: {
  id: string;
  level: string;
  kind: string;
  message: string;
}): Promise<{ sent: boolean; status: TelegramStatus | "SKIPPED" | "FAILED" }> {
  if (!isImportantAlertKind(alert.kind)) return { sent: false, status: "SKIPPED" };
  if (telegramStatus() === "NOT_CONFIGURED") return { sent: false, status: "NOT_CONFIGURED" };

  const { data: claimed } = await supabaseAdmin
    .from("alerts")
    .update({ notified_at: new Date().toISOString() })
    .eq("id", alert.id)
    .is("notified_at", null)
    .select("id");
  if (!claimed?.length) return { sent: false, status: "SKIPPED" };

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
    if (!res.ok) return { sent: false, status: "FAILED" };
    return { sent: true, status: "CONFIGURED" };
  } catch {
    return { sent: false, status: "FAILED" };
  }
}