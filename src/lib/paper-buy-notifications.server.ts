import { supabaseAdmin } from "@/integrations/supabase/client.server";

const BUYS_PER_MESSAGE = 12;
const MAX_BUYS_PER_SCAN = 120;

type PaperBuyRow = {
  trade_id: string;
  experiment_id: string;
  experiment_name: string;
  event_key: string;
  market_title: string | null;
  outcome: string | null;
  price: number | null;
  shares: number;
  notional: number;
  cash_after: number | null;
  source_ts: number | null;
  created_at: string;
};

function shortTitle(title: string): string {
  return title.length <= 90 ? title : `${title.slice(0, 87)}…`;
}

export function formatPaperBuyMessage(
  experimentName: string,
  buys: readonly Pick<
    PaperBuyRow,
    "market_title" | "outcome" | "price" | "shares" | "notional" | "cash_after"
  >[],
  chunkNumber: number,
  chunkCount: number,
): string {
  const suffix = chunkCount > 1 ? ` (${chunkNumber}/${chunkCount})` : "";
  const lines = buys.map((buy, index) => {
    const price = buy.price === null ? "price unavailable" : `${(Number(buy.price) * 100).toFixed(1)}¢`;
    const outcome = buy.outcome ? ` · ${buy.outcome}` : "";
    const cash = buy.cash_after === null ? "" : ` · cash $${Number(buy.cash_after).toFixed(2)}`;
    return `${index + 1}. $${Number(buy.notional).toFixed(2)} · ${Number(buy.shares).toFixed(4)} sh @ ${price}${outcome}${cash}\n${shortTitle(buy.market_title ?? "Unknown market")}`;
  });
  return `PAPER BUY EXECUTED — ${experimentName}${suffix}\n${lines.join("\n")}`;
}

/**
 * Durable paper-BUY outbox producer.
 *
 * This deliberately does NOT trust the current cycle summary. Paper accounting
 * can commit a BUY and then have a later best-effort stage/deadline fail, in
 * which case runIngestCycle exposes an empty/error cycle even though the BUY is
 * permanently present in paper_trades. The database cursor RPC reads directly
 * from that durable ledger, so the next scheduler invocation still finds it.
 *
 * The cursor advances only after every alert for the returned batch has been
 * durably upserted. A crash before cursor advance simply replays the same batch;
 * deterministic dedup keys make that safe. Telegram delivery itself happens
 * later through retryPendingTelegramAlerts, after all worker leases/accounting
 * work is already closed.
 */
export async function queuePaperBuyNotifications(): Promise<{
  buysFound: number;
  alertsQueued: number;
  cursorAdvanced: boolean;
}> {
  const { data, error } = await supabaseAdmin.rpc(
    "get_pending_paper_buy_notification_trades" as never,
    { p_limit: MAX_BUYS_PER_SCAN } as never,
  );
  if (error) throw new Error(`paper BUY notification scan failed: ${error.message}`);

  const buys = (data ?? []) as unknown as PaperBuyRow[];
  if (buys.length === 0) return { buysFound: 0, alertsQueued: 0, cursorAdvanced: false };

  // Group by experiment for readable Telegram messages. Map preserves first
  // encounter order, and each experiment's rows remain in the RPC's stable
  // (created_at, trade_id) order, so a replay before cursor advance produces
  // byte-identical chunks/dedup keys.
  const byExperiment = new Map<string, PaperBuyRow[]>();
  for (const buy of buys) {
    const rows = byExperiment.get(buy.experiment_id) ?? [];
    rows.push(buy);
    byExperiment.set(buy.experiment_id, rows);
  }

  let alertsQueued = 0;
  for (const [experimentId, experimentBuys] of byExperiment) {
    const chunks: PaperBuyRow[][] = [];
    for (let i = 0; i < experimentBuys.length; i += BUYS_PER_MESSAGE) {
      chunks.push(experimentBuys.slice(i, i + BUYS_PER_MESSAGE));
    }

    for (let i = 0; i < chunks.length; i += 1) {
      const chunk = chunks[i]!;
      const firstTradeId = chunk[0]!.trade_id;
      const lastTradeId = chunk.at(-1)!.trade_id;
      const dedupKey = `paper_buy:${experimentId}:${firstTradeId}:${lastTradeId}:${chunk.length}`;
      const experimentName = chunk[0]!.experiment_name;
      const message = formatPaperBuyMessage(experimentName, chunk, i + 1, chunks.length);
      const { data: inserted, error: alertError } = await supabaseAdmin
        .from("alerts")
        .upsert(
          {
            level: "info",
            kind: "paper_buy",
            message,
            context: {
              experiment: experimentName,
              experiment_id: experimentId,
              buy_count: chunk.length,
              trade_ids: chunk.map((buy) => buy.trade_id),
              event_keys: chunk.map((buy) => buy.event_key),
            } as never,
            dedup_key: dedupKey,
          },
          { onConflict: "dedup_key", ignoreDuplicates: true },
        )
        .select("id");
      if (alertError) {
        // Fail closed: do not advance the durable cursor past any BUY whose
        // alert batch was not safely queued. Already-inserted chunks dedup on
        // the next pass.
        throw new Error(`paper BUY alert queue failed: ${alertError.message}`);
      }
      if (inserted?.length) alertsQueued += 1;
    }
  }

  const last = buys.at(-1)!;
  const { error: advanceError } = await supabaseAdmin.rpc(
    "advance_paper_buy_notification_cursor" as never,
    {
      p_last_created_at: last.created_at,
      p_last_trade_id: last.trade_id,
    } as never,
  );
  if (advanceError) {
    throw new Error(`paper BUY notification cursor advance failed: ${advanceError.message}`);
  }

  return { buysFound: buys.length, alertsQueued, cursorAdvanced: true };
}
