/**
 * FINAL BUILD Part 7: scalable, authoritative per-epoch counters — SERVER (DB) layer.
 *
 * Backed by get_sports_shadow_epoch_counters (an indexed SQL aggregate, see migration
 * 20260824010000), computed server-side over the COMPLETE epoch regardless of how many
 * rows it contains -- this module never issues a bounded/`.limit()` query itself, and
 * never scans sports_shadow_signals row-by-row in JS. Callers that need a bounded
 * dashboard read (recent activity, not authoritative counts) keep their own separate
 * bounded query; this is exclusively for counts that must be correct at any volume.
 */

import { supabaseAdmin } from "@/integrations/supabase/client.server";

export type EpochCounters = {
  rawEpisodeCount: number;
  independentEpisodeCount: number;
  settledIndependentCount: number;
  settledCount: number;
  rejectedCount: number;
  calibrationIndependentSettledCount: number;
  oosIndependentSettledCount: number;
};

type RawCountersRow = {
  raw_episode_count: number;
  independent_episode_count: number;
  settled_independent_count: number;
  settled_count: number;
  rejected_count: number;
  calibration_independent_settled_count: number;
  oos_independent_settled_count: number;
};

const EMPTY_COUNTERS: EpochCounters = {
  rawEpisodeCount: 0,
  independentEpisodeCount: 0,
  settledIndependentCount: 0,
  settledCount: 0,
  rejectedCount: 0,
  calibrationIndependentSettledCount: 0,
  oosIndependentSettledCount: 0,
};

export async function getEpochCounters(epochId: string): Promise<EpochCounters> {
  const { data, error } = await supabaseAdmin.rpc("get_sports_shadow_epoch_counters" as never, { p_epoch_id: epochId } as never);
  if (error) throw new Error(error.message);
  const rows = (data ?? []) as unknown as RawCountersRow[];
  const row = rows[0];
  if (!row) return EMPTY_COUNTERS;
  return {
    rawEpisodeCount: Number(row.raw_episode_count),
    independentEpisodeCount: Number(row.independent_episode_count),
    settledIndependentCount: Number(row.settled_independent_count),
    settledCount: Number(row.settled_count),
    rejectedCount: Number(row.rejected_count),
    calibrationIndependentSettledCount: Number(row.calibration_independent_settled_count),
    oosIndependentSettledCount: Number(row.oos_independent_settled_count),
  };
}

export type NextMilestone = "100_INDEPENDENT_SETTLED" | "300_INDEPENDENT_SETTLED" | null;

/** Pure -- matches the CALIBRATION_MIN_INDEPENDENT_EPISODES/OOS_MIN_INDEPENDENT_EPISODES gates in stage.ts (100 / 200 additional, i.e. 300 total). */
export function nextMilestoneFor(counters: EpochCounters): NextMilestone {
  if (counters.settledIndependentCount < 100) return "100_INDEPENDENT_SETTLED";
  if (counters.settledIndependentCount < 300) return "300_INDEPENDENT_SETTLED";
  return null;
}
