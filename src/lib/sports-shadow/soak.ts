/**
 * FINAL BUILD Part 6: operational soak health rollup — PURE math only.
 *
 * Replaces the "first-pass single-cycle heuristic" (worker.server.ts previously passed
 * `summary.errors.length === 0` -- ONE cycle's own error count -- as if it were the
 * whole 72h soak's health) with a real evaluation against explicit thresholds, computed
 * from a rollup AGGREGATED OVER THE ENTIRE SOAK WINDOW (soak.server.ts sources this from
 * sports_shadow_telemetry_events, sports_shadow_integrity_audits, and
 * sports_shadow_settlements -- all durable tables a process restart cannot erase).
 *
 * 72 hours elapsing is necessary but NOT sufficient (the mission's own explicit rule):
 * stage.ts's duration gate and this module's health gate are two independent
 * conditions, both required before OPERATIONAL_SOAK -> CALIBRATION.
 */

export type SoakHealthInput = {
  /** Number of cycles that actually ran (one SYSTEM cycle_duration_ms telemetry event per cycle) during the soak window. */
  actualCycleCount: number;
  /** (soak window duration) / (expected external-scheduler cadence) -- see soak.server.ts's EXPECTED_CYCLE_INTERVAL_MS for the assumed cadence and why it is an explicit, documented assumption. */
  expectedCycleCount: number;
  totalCycleErrors: number;
  /** Sum of OBSERVATION `skipped` telemetry across both venues -- the backlog Part 6 names. */
  observationBacklogTotal: number;
  observationAttemptedTotal: number;
  pmusDiscoveryFailedCount: number;
  pmusDiscoveryAttemptedCycles: number;
  kalshiDiscoveryFailedCount: number;
  kalshiDiscoveryAttemptedCycles: number;
  /** Cycles where the source lane attempted zero wallets despite the lane being acquired -- a proxy for the source side going quiet independent of any specific venue. */
  sourceStarvedCycles: number;
  sourceLaneAcquiredCycles: number;
  leaseLostCount: number;
  integrityAuditFailures: number;
  integrityAuditsRun: number;
  /** Settlements still PENDING well past a reasonable settlement window -- see soak.server.ts's SETTLEMENT_STUCK_THRESHOLD_MS. */
  settlementStuckCount: number;
  /** CODEX P2-5: real durable count of 429 events across the soak window (telemetry.server.ts's `rate_limited_429` NETWORK events) -- see soak.server.ts's own doc comment. */
  rateLimitStormCount: number;
  /** CODEX P2-2: real durable count of 429-cooldown PERSISTENCE failures (telemetry.server.ts's `rate_limit_persist_failed` NETWORK events) across the soak window -- distinct from rateLimitStormCount: this measures OUR OWN durable coordination breaking, not upstream 429 volume. */
  rateLimitPersistFailureCount: number;
  /** CODEX P1-1 (round 2): number of tracked wallets currently in a durably-proven, unresolved source-coverage-gap state (sports_shadow_wallet_coverage.coverage_complete = false) -- a CURRENT snapshot, not a window-scoped count (an unresolved gap is a standing condition, not a discrete event to sum). Also enforced as an absolute cross-stage block in stage.ts, independent of this soak-specific health report. */
  walletsWithIncompleteCoverageCount: number;
};

export const SOAK_HEALTH_THRESHOLDS = {
  /** Tolerant of real-world scheduler jitter/skipped invocations (the hook route's own documented tolerance) -- this is a floor against the scheduler having effectively stopped, not a strict cadence check. */
  minCycleCompletionRatio: 0.5,
  maxCycleErrorRate: 0.1,
  maxObservationBacklogRatio: 0.2,
  maxVenueDiscoveryFailureRatio: 0.3,
  maxSourceStarvationRatio: 0.3,
  maxLeaseLostRatio: 0.05,
  maxRateLimitStormCount: 0,
  maxRateLimitPersistFailureCount: 0,
  maxWalletsWithIncompleteCoverageCount: 0,
  maxSettlementStuckCount: 0,
} as const;

export type SoakHealthResult = { passed: boolean; failedChecks: string[] };

function ratio(numerator: number, denominator: number): number {
  return denominator > 0 ? numerator / denominator : 0;
}

export function evaluateSoakHealth(input: SoakHealthInput, thresholds = SOAK_HEALTH_THRESHOLDS): SoakHealthResult {
  const failedChecks: string[] = [];

  const completionRatio = ratio(input.actualCycleCount, input.expectedCycleCount);
  if (input.expectedCycleCount > 0 && completionRatio < thresholds.minCycleCompletionRatio) {
    failedChecks.push(`scheduler completion ratio ${(completionRatio * 100).toFixed(1)}% is below the ${(thresholds.minCycleCompletionRatio * 100).toFixed(0)}% floor (${input.actualCycleCount}/${input.expectedCycleCount} expected cycles ran)`);
  }

  const errorRate = ratio(input.totalCycleErrors, input.actualCycleCount);
  if (errorRate > thresholds.maxCycleErrorRate) {
    failedChecks.push(`cycle error rate ${(errorRate * 100).toFixed(1)}% exceeds the ${(thresholds.maxCycleErrorRate * 100).toFixed(0)}% threshold`);
  }

  const backlogRatio = ratio(input.observationBacklogTotal, input.observationAttemptedTotal);
  if (backlogRatio > thresholds.maxObservationBacklogRatio) {
    failedChecks.push(`observation backlog ratio ${(backlogRatio * 100).toFixed(1)}% exceeds the ${(thresholds.maxObservationBacklogRatio * 100).toFixed(0)}% threshold (sustained backlog, not a transient blip)`);
  }

  const pmusFailureRatio = ratio(input.pmusDiscoveryFailedCount, input.pmusDiscoveryAttemptedCycles);
  if (pmusFailureRatio > thresholds.maxVenueDiscoveryFailureRatio) {
    failedChecks.push(`PM-US discovery failure ratio ${(pmusFailureRatio * 100).toFixed(1)}% exceeds threshold -- PM-US starvation`);
  }
  const kalshiFailureRatio = ratio(input.kalshiDiscoveryFailedCount, input.kalshiDiscoveryAttemptedCycles);
  if (kalshiFailureRatio > thresholds.maxVenueDiscoveryFailureRatio) {
    failedChecks.push(`Kalshi discovery failure ratio ${(kalshiFailureRatio * 100).toFixed(1)}% exceeds threshold -- Kalshi starvation`);
  }

  const sourceStarvationRatio = ratio(input.sourceStarvedCycles, input.sourceLaneAcquiredCycles);
  if (sourceStarvationRatio > thresholds.maxSourceStarvationRatio) {
    failedChecks.push(`source lane attempted zero wallets in ${(sourceStarvationRatio * 100).toFixed(1)}% of acquired cycles -- source starvation`);
  }

  const leaseLostRatio = ratio(input.leaseLostCount, input.actualCycleCount);
  if (leaseLostRatio > thresholds.maxLeaseLostRatio) {
    failedChecks.push(`lease-loss ratio ${(leaseLostRatio * 100).toFixed(1)}% exceeds the ${(thresholds.maxLeaseLostRatio * 100).toFixed(0)}% threshold`);
  }

  if (input.integrityAuditFailures > 0) {
    failedChecks.push(`${input.integrityAuditFailures} integrity audit failure(s) recorded during the soak window`);
  }

  if (input.settlementStuckCount > thresholds.maxSettlementStuckCount) {
    failedChecks.push(`${input.settlementStuckCount} settlement(s) stuck PENDING beyond the expected window`);
  }

  if (input.rateLimitStormCount > thresholds.maxRateLimitStormCount) {
    failedChecks.push(`${input.rateLimitStormCount} rate-limit storm event(s) recorded`);
  }

  if (input.rateLimitPersistFailureCount > thresholds.maxRateLimitPersistFailureCount) {
    failedChecks.push(`${input.rateLimitPersistFailureCount} rate-limit-cooldown persistence failure(s) recorded -- durable rate-limit coordination was degraded`);
  }

  if (input.walletsWithIncompleteCoverageCount > thresholds.maxWalletsWithIncompleteCoverageCount) {
    failedChecks.push(`${input.walletsWithIncompleteCoverageCount} wallet(s) have an unresolved source-coverage gap`);
  }

  return { passed: failedChecks.length === 0, failedChecks };
}
