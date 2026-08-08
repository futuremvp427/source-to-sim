/**
 * Compact live status of the V2 fair-comparison cohort.
 * Read-only. Every figure describes the PAPER SIMULATION only.
 */

import { supabaseAdmin } from "@/integrations/supabase/client.server";

import { V2_COHORT, V2_PREFIX, isV2Name } from "./v2-cohort";
import { workerIdFor } from "./shadow.server";

export type V2StatusReport = {
  generatedAt: string;
  running: boolean;
  goLiveTs: number | null;
  goLiveAt: string | null;
  enabledCount: number;
  expectedCount: number;
  newestSuccessAt: string | null;
  newV2SourceEvents: number | null;
  v2PaperTrades: number;
  pollFailures: number;
  allWorkersHealthy: boolean;
  workers: { name: string; state: string | null; lastSuccessAt: string | null; lastError: string | null }[];
  note: string;
};

const NOTE =
  "Only source trades detected after V2 go-live are eligible for V2 paper copying. Historical fills are retained for research but are not replayed.";

export async function loadV2Status(): Promise<V2StatusReport> {
  const { data: rows } = await supabaseAdmin
    .from("paper_experiments")
    .select("id, name, wallet_address, enabled, follow_from_ts")
    .like("name", `${V2_PREFIX}%`);

  const experiments = (rows ?? []).filter((r) => isV2Name(r.name));
  const enabled = experiments.filter((r) => r.enabled);
  const goLiveCandidates = experiments
    .map((r) => (r.follow_from_ts === null ? null : Number(r.follow_from_ts)))
    .filter((v): v is number => v !== null && Number.isFinite(v));
  const goLiveTs = goLiveCandidates.length ? Math.min(...goLiveCandidates) : null;

  const workers: V2StatusReport["workers"] = [];
  let pollFailures = 0;
  let newestSuccessAt: string | null = null;
  for (const experiment of experiments) {
    const { data: status } = await supabaseAdmin
      .from("worker_status")
      .select("state, last_success_at, last_error, poll_failures")
      .eq("id", workerIdFor({ id: experiment.id, name: experiment.name }))
      .maybeSingle();
    pollFailures += Number(status?.poll_failures ?? 0);
    if (status?.last_success_at && (!newestSuccessAt || status.last_success_at > newestSuccessAt)) {
      newestSuccessAt = status.last_success_at;
    }
    workers.push({
      name: experiment.name,
      state: status?.state ?? null,
      lastSuccessAt: status?.last_success_at ?? null,
      lastError: status?.last_error ?? null,
    });
  }

  let newV2SourceEvents: number | null = null;
  if (goLiveTs !== null) {
    const wallets = [...new Set(experiments.map((r) => r.wallet_address.toLowerCase()))];
    const { count } = await supabaseAdmin
      .from("source_events")
      .select("*", { count: "exact", head: true })
      .in("wallet", wallets)
      .gte("source_ts", goLiveTs);
    newV2SourceEvents = count ?? 0;
  }

  const ids = experiments.map((r) => r.id);
  let v2PaperTrades = 0;
  if (ids.length > 0) {
    const { count } = await supabaseAdmin
      .from("paper_trades")
      .select("*", { count: "exact", head: true })
      .in("experiment_id", ids);
    v2PaperTrades = count ?? 0;
  }

  const allWorkersHealthy =
    workers.length === V2_COHORT.length && workers.every((w) => w.state !== null && w.state !== "error");

  return {
    generatedAt: new Date().toISOString(),
    running: enabled.length === V2_COHORT.length && goLiveTs !== null,
    goLiveTs,
    goLiveAt: goLiveTs === null ? null : new Date(goLiveTs * 1000).toISOString(),
    enabledCount: enabled.length,
    expectedCount: V2_COHORT.length,
    newestSuccessAt,
    newV2SourceEvents,
    v2PaperTrades,
    pollFailures,
    allWorkersHealthy,
    workers,
    note: NOTE,
  };
}
