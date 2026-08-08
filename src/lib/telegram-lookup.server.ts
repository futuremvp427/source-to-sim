type TelegramRecord = Record<string, unknown>;

function isRecord(value: unknown): value is TelegramRecord {
  return typeof value === "object" && value !== null;
}

function isStartCommand(text: string): boolean {
  return /^\/start(?:@[^\s]+)?(?:\s|$)/.test(text.trim());
}

/** Returns the latest private chat that sent /start, using only the bot token server-side. */
export async function findLatestPrivateStartChatId(): Promise<number> {
  const token = process.env["TELEGRAM_BOT_TOKEN"];
  if (!token) throw new Error("Telegram bot token is not configured");

  const response = await fetch(`https://api.telegram.org/bot${token}/getUpdates`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ offset: -100, limit: 100, allowed_updates: ["message"] }),
    signal: AbortSignal.timeout(10_000),
  });

  if (!response.ok) throw new Error("Telegram getUpdates failed");

  const payload: unknown = await response.json();
  if (!isRecord(payload) || payload["ok"] !== true || !Array.isArray(payload["result"])) {
    throw new Error("Telegram getUpdates returned an invalid response");
  }

  let latest: { updateId: number; chatId: number } | null = null;
  for (const item of payload["result"]) {
    if (!isRecord(item) || typeof item["update_id"] !== "number") continue;
    const message = item["message"];
    if (!isRecord(message) || typeof message["text"] !== "string") continue;
    const chat = message["chat"];
    if (!isRecord(chat) || chat["type"] !== "private" || typeof chat["id"] !== "number") continue;
    if (!isStartCommand(message["text"])) continue;

    if (!latest || item["update_id"] > latest.updateId) {
      latest = { updateId: item["update_id"], chatId: chat["id"] };
    }
  }

  if (!latest) throw new Error("No private /start message found");
  return latest.chatId;
}
