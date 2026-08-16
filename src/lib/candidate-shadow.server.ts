import { supabaseAdmin } from "@/integrations/supabase/client.server";

export type CandidatePaperTrade = {
  id: string;
  eventKey: string;
  action: string;
  side: string | null;
  marketTitle: string;
  outcome: string | null;
  price: number | null;
  shares: number;
  notional: number;
  reason: string | null;
  cashAfter: number | null;
  realizedPnl: number;
  sourceTs: number | null;
  createdAt: string;
};

export type CandidatePaperFollower = {
  id: string;
  name: string;
  wallet: string;
  startingCash: number;
  cash: number;
  realizedPnl: number;
  sizingRule: string;
  enabled: boolean;
  weatherOnly: boolean;
  simulated: boolean;
  followFromTs: number | null;
  worker: {
    state: string;
    heartbeatAt: string | null;
    heartbeatAgeSeconds: number | null;
    lastSuccessAt: string | null;
    lastPollAt: string | null;
    lastError: string | null;
    pollFailures: number;
  };
  checkpoint: {
    bootstrapComplete: boolean;
    lastSourceTs: number;
    eventsSeen: number;
  };
  openPositions: number;
  openCostBasis: number;
  recentTrades: CandidatePaperTrade[];
};

export type CandidateShadowPanelData = {
  fetchedAt: string;
  followers: CandidatePaperFollower[];
};

type ExperimentRow = {
  id: string;
  name: string;
  wallet_address: string;
  starting_cash: number;
  cash: number;
  realized_pnl: number;
  sizing_rule: string;
  enabled: boolean;
  weather_only: boolean;
  simulated: boolean;
  follow_from_ts: number | null;
};

export async function loadCandidateShadowPanel(): Promise<CandidateShadowPanelData> {
  const nowMs = Date.now();
  const { data: rawExperiments, error: experimentsError } = await supabaseAdmin
    .from("paper_experiments")
    .select(
      "id, name, wallet_address, starting_cash, cash, realized_pnl, sizing_rule, enabled, weather_only, simulated, follow_from_ts",
    )
    .like("name", "CANDIDATE: %")
    .order("name", { ascending: true });
  if (experimentsError) throw new Error(`candidate paper experiments read failed: ${experimentsError.message}`);

  const experiments = (rawExperiments ?? []) as unknown as ExperimentRow[];
  if (experiments.length === 0) return { fetchedAt: new Date(nowMs).toISOString(), followers: [] };

  const experimentIds = experiments.map((e) => e.id);
  const workerIds = experiments.map((e) => `ingest:${e.id}`);

  const [statusRes, checkpointRes, positionsRes, tradesPerExperiment] = await Promise.all([
    supabaseAdmin
      .from("worker_status")
      .select("id, state, heartbeat_at, last_success_at, last_poll_at, last_error, poll_failures")
      .in("id", workerIds),
    supabaseAdmin
      .from("worker_checkpoints")
      .select("id, bootstrap_complete, last_source_ts, events_seen")
      .in("id", workerIds),
    supabaseAdmin
      .from("paper_positions")
      .select("experiment_id, shares, cost_basis")
      .in("experiment_id", experimentIds)
      .gt("shares", 0),
    Promise.all(
      experiments.map(async (experiment) => {
        const { data, error } = await supabaseAdmin
          .from("paper_trades")
          .select(
            "id, event_key, action, side, market_title, outcome, price, shares, notional, reason, cash_after, realized_pnl, source_ts, created_at",
          )
          .eq("experiment_id", experiment.id)
          .order("created_at", { ascending: false })
          .limit(10);
        if (error) throw new Error(`candidate recent trades read failed for ${experiment.name}: ${error.message}`);
        return [experiment.id, data ?? []] as const;
      }),
    ),
  ]);

  if (statusRes.error) throw new Error(`candidate worker status read failed: ${statusRes.error.message}`);
  if (checkpointRes.error) throw new Error(`candidate checkpoint read failed: ${checkpointRes.error.message}`);
  if (positionsRes.error) throw new Error(`candidate open positions read failed: ${positionsRes.error.message}`);

  const statusById = new Map((statusRes.data ?? []).map((row) => [row.id, row]));
  const checkpointById = new Map((checkpointRes.data ?? []).map((row) => [row.id, row]));
  const tradesByExperiment = new Map(tradesPerExperiment);

  const followers = experiments.map((experiment): CandidatePaperFollower => {
    const workerId = `ingest:${experiment.id}`;
    const status = statusById.get(workerId);
    const checkpoint = checkpointById.get(workerId);
    const positions = (positionsRes.data ?? []).filter((p) => p.experiment_id === experiment.id);
    const heartbeatAgeSeconds = status?.heartbeat_at
      ? Math.max(0, Math.round((nowMs - new Date(status.heartbeat_at).getTime()) / 1000))
      : null;

    return {
      id: experiment.id,
      name: experiment.name,
      wallet: experiment.wallet_address,
      startingCash: Number(experiment.starting_cash),
      cash: Number(experiment.cash),
      realizedPnl: Number(experiment.realized_pnl),
      sizingRule: experiment.sizing_rule,
      enabled: experiment.enabled,
      weatherOnly: experiment.weather_only,
      simulated: experiment.simulated,
      followFromTs: experiment.follow_from_ts === null ? null : Number(experiment.follow_from_ts),
      worker: {
        state: status?.state ?? "stopped",
        heartbeatAt: status?.heartbeat_at ?? null,
        heartbeatAgeSeconds,
        lastSuccessAt: status?.last_success_at ?? null,
        lastPollAt: status?.last_poll_at ?? null,
        lastError: status?.last_error ?? null,
        pollFailures: Number(status?.poll_failures ?? 0),
      },
      checkpoint: {
        bootstrapComplete: checkpoint?.bootstrap_complete ?? false,
        lastSourceTs: Number(checkpoint?.last_source_ts ?? 0),
        eventsSeen: Number(checkpoint?.events_seen ?? 0),
      },
      openPositions: positions.length,
      openCostBasis: positions.reduce((sum, p) => sum + Number(p.cost_basis), 0),
      recentTrades: ((tradesByExperiment.get(experiment.id) ?? []) as Array<Record<string, unknown>>).map(
        (trade): CandidatePaperTrade => ({
          id: String(trade["id"]),
          eventKey: String(trade["event_key"]),
          action: String(trade["action"]),
          side: trade["side"] === null ? null : String(trade["side"]),
          marketTitle: trade["market_title"] ? String(trade["market_title"]) : "Unknown market",
          outcome: trade["outcome"] === null ? null : String(trade["outcome"]),
          price: trade["price"] === null ? null : Number(trade["price"]),
          shares: Number(trade["shares"] ?? 0),
          notional: Number(trade["notional"] ?? 0),
          reason: trade["reason"] === null ? null : String(trade["reason"]),
          cashAfter: trade["cash_after"] === null ? null : Number(trade["cash_after"]),
          realizedPnl: Number(trade["realized_pnl"] ?? 0),
          sourceTs: trade["source_ts"] === null ? null : Number(trade["source_ts"]),
          createdAt: String(trade["created_at"]),
        }),
      ),
    };
  });

  return { fetchedAt: new Date(nowMs).toISOString(), followers };
}
