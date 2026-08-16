import { supabaseAdmin } from "@/integrations/supabase/client.server";

const BUYS_PER_MESSAGE = 12;

type CycleLike = {
  ranAt: string;
  experimentName: string;
  process: { buys: number };
};

type PaperBuyRow = {
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
  buys: readonly PaperBuyRow[],
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
 * Creates Telegram-eligible `paper_buy` alerts only from BUY rows that are
 * already persisted in paper_trades. This runs after runIngestCycle returns,
 * so Telegram can never hold a worker lease, checkpoint advance, or accounting
 * transaction open. The normal notification retry pass sends the queued rows.
 */
export async function queuePaperBuyNotifications(
  cycles: readonly CycleLike[],
): Promise<{ buysFound: number; alertsQueued: number }> {
  let buysFound = 0;
  let alertsQueued = 0;

  for (const cycle of cycles) {
    if (cycle.process.buys <= 0) continue;

    const { data: experiment, error: experimentError } = await supabaseAdmin
      .from("paper_experiments")
      .select("id")
      .eq("name", cycle.experimentName)
      .maybeSingle();
    if (experimentError || !experiment?.id) continue;

    const { data: rawBuys, error: buysError } = await supabaseAdmin
      .from("paper_trades")
      .select("event_key, market_title, outcome, price, shares, notional, cash_after, source_ts, created_at")
      .eq("experiment_id", experiment.id)
      .eq("action", "BUY")
      .gte("created_at", cycle.ranAt)
      .order("created_at", { ascending: true })
      .limit(Math.max(1, Math.min(cycle.process.buys, 300)));
    if (buysError) continue;

    const buys = (rawBuys ?? []) as unknown as PaperBuyRow[];
    if (buys.length === 0) continue;
    buysFound += buys.length;

    const chunks: PaperBuyRow[][] = [];
    for (let i = 0; i < buys.length; i += BUYS_PER_MESSAGE) {
      chunks.push(buys.slice(i, i + BUYS_PER_MESSAGE));
    }

    for (let i = 0; i < chunks.length; i += 1) {
      const chunk = chunks[i]!;
      const firstKey = chunk[0]?.event_key ?? "none";
      const lastKey = chunk.at(-1)?.event_key ?? firstKey;
      const dedupKey = `paper_buy:${experiment.id}:${firstKey}:${lastKey}:${chunk.length}`;
      const message = formatPaperBuyMessage(cycle.experimentName, chunk, i + 1, chunks.length);
      const { data: inserted, error: alertError } = await supabaseAdmin
        .from("alerts")
        .upsert(
          {
            level: "info",
            kind: "paper_buy",
            message,
            context: {
              experiment: cycle.experimentName,
              experiment_id: experiment.id,
              buy_count: chunk.length,
              event_keys: chunk.map((buy) => buy.event_key),
            } as never,
            dedup_key: dedupKey,
          },
          { onConflict: "dedup_key", ignoreDuplicates: true },
        )
        .select("id");
      if (!alertError && inserted?.length) alertsQueued += 1;
    }
  }

  return { buysFound, alertsQueued };
}
