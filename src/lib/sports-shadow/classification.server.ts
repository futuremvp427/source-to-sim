/**
 * FINAL BUILD Part 5 (server wiring): assembles classification.ts's pure gate inputs
 * from real, persisted data — SERVER (DB) layer. The classification/gate LOGIC itself
 * stays entirely in classification.ts (pure, unit-tested); this module's only job is
 * fetching what that logic needs.
 */

import { supabaseAdmin } from "@/integrations/supabase/client.server";

import { computeEpisodeAnalysisReport, fetchAllEpisodeOutcomes, type EpisodeAnalysisReport } from "./analytics.server";
import { DECLARED_STRATEGY_NOTIONAL_USD } from "./analytics";
import {
  classifyCalibration,
  classifyOos,
  evaluateLivePilotGate,
  type CalibrationClassification,
  type LivePilotGateInput,
  type LivePilotGateResult,
  type OosClassification,
} from "./classification";

async function latestIntegrityAuditPassed(): Promise<boolean> {
  const { data, error } = await supabaseAdmin
    .from("sports_shadow_integrity_audits" as never)
    .select("passed")
    .order("run_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) throw new Error(error.message);
  const row = data as unknown as { passed: boolean } | null;
  // No audit has ever run yet -- fails CLOSED (never assume clean without evidence).
  return row?.passed ?? false;
}

/**
 * NEAR/UNVERIFIED matches represent genuine matching ambiguity worth a human's
 * attention -- NONE is excluded deliberately: "no venue counterpart exists" is an
 * ordinary, expected outcome for many signals, not an unresolved issue.
 */
async function hasUnresolvedMatchingIssues(epochId: string): Promise<boolean> {
  const { data: signalIdsData, error: signalsError } = await supabaseAdmin
    .from("sports_shadow_signals" as never)
    .select("id")
    .eq("experiment_epoch_id", epochId);
  if (signalsError) throw new Error(signalsError.message);
  const signalIds = ((signalIdsData ?? []) as unknown as { id: string }[]).map((r) => r.id);
  if (signalIds.length === 0) return false;

  const { count, error } = await supabaseAdmin
    .from("sports_market_matches" as never)
    .select("id", { count: "exact", head: true })
    .in("match_status", ["NEAR", "UNVERIFIED"])
    .in("signal_id", signalIds);
  if (error) throw new Error(error.message);
  return (count ?? 0) > 0;
}

export type CalibrationEvaluation = { classification: CalibrationClassification; report: EpisodeAnalysisReport };

export async function evaluateCalibrationClassification(epochId: string, calibrationStartedAtIso: string): Promise<CalibrationEvaluation> {
  const allRows = await fetchAllEpisodeOutcomes(epochId);
  const report = computeEpisodeAnalysisReport(allRows, { sinceIso: calibrationStartedAtIso, untilIso: null }, DECLARED_STRATEGY_NOTIONAL_USD);
  const classification = classifyCalibration({
    independentSettledCount: report.analytics.core.independentSettledCount,
    expectancyPerIndependentEpisodeUsd: report.analytics.core.expectancyPerIndependentEpisode,
    bootstrapProbabilityPositive: report.bootstrap.probabilityPositive,
  });
  return { classification, report };
}

export type OosEvaluation = { classification: OosClassification; gate: LivePilotGateResult; report: EpisodeAnalysisReport };

/**
 * `oosSampleAndDurationMet` is passed in by the caller (stage.server.ts already knows
 * this cheaply from the same counter it uses for the stage transition itself) so this
 * function never re-derives it and the two can never silently disagree.
 *
 * `epochContaminationDetected` is always false here: epoch.server.ts's ensureCurrentEpoch
 * already starts a BRAND NEW epoch the instant any version/config drift is detected
 * (requiresNewEpoch), so a single epoch's own lifetime cannot mix incompatible versions
 * by construction -- there is nothing for this function to detect that isn't already
 * prevented upstream. `operationalHealthAcceptable` reflects the LATEST integrity audit
 * only during OOS (the dedicated multi-cycle rollup in soak.server.ts governs entry into
 * CALIBRATION specifically, not ongoing OOS-stage health -- a separate rollup for the
 * OOS window is not yet built in this pass).
 */
export async function evaluateOosClassification(epochId: string, oosStartedAtIso: string, oosSampleAndDurationMet: boolean): Promise<OosEvaluation> {
  const allRows = await fetchAllEpisodeOutcomes(epochId);
  const report = computeEpisodeAnalysisReport(allRows, { sinceIso: oosStartedAtIso, untilIso: null }, DECLARED_STRATEGY_NOTIONAL_USD);

  const [integrityAuditPassed, unresolvedMatchingIssues] = await Promise.all([latestIntegrityAuditPassed(), hasUnresolvedMatchingIssues(epochId)]);

  const gateInput: LivePilotGateInput = {
    oosSampleAndDurationMet,
    oosExpectancyPerIndependentEpisodeUsd: report.analytics.core.expectancyPerIndependentEpisode,
    oneCentStressExpectancyPerIndependentEpisodeUsd: report.robustness.oneCentAdverseStress.expectancyPerIndependentEpisode,
    twoCentStressExpectancyPerIndependentEpisodeUsd: report.robustness.twoCentAdverseStress.expectancyPerIndependentEpisode,
    topFiveWinsRemovedExpectancyPerIndependentEpisodeUsd: report.robustness.top5WinsRemoved.remaining.expectancyPerIndependentEpisode,
    maxDrawdownUsd: report.analytics.risk.maxDrawdownUsd,
    capitalDeployedUsd: report.analytics.core.capitalDeployedUsd,
    matchRateAtDeclaredTier: report.analytics.execution.matchRate,
    integrityAuditPassed,
    epochContaminationDetected: false,
    unresolvedMatchingIssues,
    operationalHealthAcceptable: integrityAuditPassed,
    bootstrapProbabilityPositive: report.bootstrap.probabilityPositive,
  };

  const gate = evaluateLivePilotGate(gateInput);
  const classification = classifyOos(gateInput);
  return { classification, gate, report };
}
