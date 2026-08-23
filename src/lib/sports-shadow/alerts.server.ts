/**
 * FINAL BUILD Part 27 + Telegram integration: actionable alerting — SERVER (DB) layer.
 *
 * CORRECTION from the earlier "no delivery channel exists" report: src/lib/notify.server.ts
 * already implements a Telegram adapter (IMPORTANT_KINDS filtering, durable retry via
 * retryPendingTelegramAlerts, NOT_CONFIGURED fallback) reused by src/lib/shadow.server.ts's
 * own raiseAlert(level, kind, message, context?, dedupKey?) -- a dedup-key-based
 * idempotent-insert-then-notify helper writing to the GENERAL `alerts` table.
 *
 * This module does NOT invent a new channel. `sports_shadow_alerts` remains the
 * Sports-specific durable diagnostic/audit record (its own resolve/unresolve lifecycle,
 * queryable by the dashboard) -- Telegram delivery is layered on top, triggered ONLY at
 * the moment an alert transitions from "not currently active" to "active" (this
 * module's own hasUnresolved-gated raise()), never re-sent every cycle a sustained
 * condition remains true. Milestone alerts (soak passed/failed, calibration/OOS
 * reached, LIVE_PILOT_REVIEW_READY) use a PERMANENT per-epoch dedup key instead, since
 * a milestone is a one-time event, not a resolve/unresolve condition.
 *
 * No historical replay: sports_shadow_* kinds have never been written to the general
 * `alerts` table before this change, so General Shadow's existing
 * TELEGRAM_RETRY_CUTOVER_AT backlog-suppression is trivially satisfied -- there is no
 * backlog under these kind names to replay.
 */

import { supabaseAdmin } from "@/integrations/supabase/client.server";

export type AlertSeverity = "INFO" | "WARNING" | "CRITICAL";

/** Maps 1:1 onto notify.server.ts's IMPORTANT_KINDS/DURABLE_KINDS entries -- see that module's own additions. */
export type SportsShadowAlertKind =
  | "sports_shadow_source_unhealthy"
  | "sports_shadow_source_coverage_gap"
  | "sports_shadow_venue_starved"
  | "sports_shadow_rate_limit_storm"
  | "sports_shadow_observation_backlog"
  | "sports_shadow_integrity_failed"
  | "sports_shadow_settlement_stuck"
  | "sports_shadow_scheduler_stopped"
  | "sports_shadow_soak_passed"
  | "sports_shadow_soak_failed"
  | "sports_shadow_calibration_100"
  | "sports_shadow_oos_300"
  | "sports_shadow_live_pilot_review_ready";

export type AlertRepository = {
  /** Idempotent: a second raise under the SAME alertKey while one is still unresolved is a no-op (the UNIQUE partial index on sports_shadow_alerts enforces this at the DB level too -- this checks first to avoid a noisy constraint-violation round trip every cycle). */
  raise(alertKey: string, severity: AlertSeverity, message: string): Promise<{ raised: boolean; id: string | null }>;
  resolve(alertKey: string): Promise<void>;
  hasUnresolved(alertKey: string): Promise<boolean>;
};

export const supabaseAlertRepository: AlertRepository = {
  async hasUnresolved(alertKey) {
    const { data, error } = await supabaseAdmin.from("sports_shadow_alerts" as never).select("id").eq("alert_key", alertKey).is("resolved_at", null).maybeSingle();
    if (error) throw new Error(error.message);
    return data !== null;
  },
  async raise(alertKey, severity, message) {
    if (await this.hasUnresolved(alertKey)) return { raised: false, id: null };
    const { data, error } = await supabaseAdmin.from("sports_shadow_alerts" as never).insert({ alert_key: alertKey, severity, message } as never).select("id").single();
    if (error) throw new Error(error.message);
    return { raised: true, id: (data as unknown as { id: string }).id };
  },
  async resolve(alertKey) {
    const { error } = await supabaseAdmin.from("sports_shadow_alerts" as never).update({ resolved_at: new Date().toISOString() } as never).eq("alert_key", alertKey).is("resolved_at", null);
    if (error) throw new Error(error.message);
  },
};

/** Delivers ONE alert row to Telegram via the existing General Shadow adapter -- injected so tests never touch real Supabase/Telegram. */
export type TelegramDeliveryFn = (level: "info" | "warn" | "error", kind: string, message: string, dedupKey: string) => Promise<void>;

async function defaultTelegramDelivery(level: "info" | "warn" | "error", kind: string, message: string, dedupKey: string): Promise<void> {
  const { raiseAlert: raiseGeneralAlert } = await import("../shadow.server");
  await raiseGeneralAlert(level, kind, message, undefined, dedupKey);
}

function severityToLevel(severity: AlertSeverity): "info" | "warn" | "error" {
  return severity === "CRITICAL" ? "error" : severity === "WARNING" ? "warn" : "info";
}

/**
 * Best-effort: an alerting failure must never break the operation that triggered it.
 * `kind` is the notify.server.ts-registered Telegram kind for this condition -- Telegram
 * delivery is attempted ONLY when this specific raise() call is the one that actually
 * transitioned the condition from inactive to active (raised:true), never on every
 * cycle a sustained condition remains true (Part 27's "avoid trade-by-trade noise",
 * generalized to "avoid sustained-condition spam").
 */
export async function raiseAlert(
  alertKey: string,
  severity: AlertSeverity,
  message: string,
  kind: SportsShadowAlertKind,
  repo: AlertRepository = supabaseAlertRepository,
  deliver: TelegramDeliveryFn = defaultTelegramDelivery,
): Promise<void> {
  try {
    const result = await repo.raise(alertKey, severity, message);
    if (result.raised && result.id) {
      await deliver(severityToLevel(severity), kind, message, `sports_shadow_alert:${result.id}`);
    }
  } catch {
    // Best-effort by design.
  }
}

export async function resolveAlert(alertKey: string, repo: AlertRepository = supabaseAlertRepository): Promise<void> {
  try {
    await repo.resolve(alertKey);
  } catch {
    // Best-effort by design.
  }
}

/**
 * Permanently deduplicated PER EPOCH -- a milestone is a one-time event, never
 * "resolved," so this bypasses sports_shadow_alerts' resolve/unresolve lifecycle
 * entirely and relies on the general `alerts` table's own dedup_key UNIQUE constraint
 * (ignoreDuplicates upsert in shadow.server.ts's raiseAlert) for exactly-once delivery
 * per (epoch, milestone kind) — a restart or duplicate cycle re-evaluation can call this
 * as many times as it wants without ever double-sending.
 */
export async function raiseMilestoneAlert(
  epochId: string,
  kind: SportsShadowAlertKind,
  message: string,
  deliver: TelegramDeliveryFn = defaultTelegramDelivery,
): Promise<void> {
  try {
    await deliver("info", kind, message, `sports_shadow_milestone:${epochId}:${kind}`);
  } catch {
    // Best-effort by design.
  }
}

export type AlertCondition = { alertKey: string; severity: AlertSeverity; message: string; kind: SportsShadowAlertKind };

/**
 * Evaluates the fixed set of meaningful conditions Part 27 lists against ALREADY-
 * COMPUTED inputs (a cycle summary, an integrity audit result) -- never queries
 * anything itself, so it stays trivially testable and has zero extra DB round trips
 * beyond what the caller already paid for. Deliberately does NOT alert on ordinary
 * per-trade activity.
 */
export function evaluateAlertConditions(input: {
  pmusDiscoveryFailed: boolean;
  kalshiDiscoveryFailed: boolean;
  pmusLeaseLost: boolean;
  kalshiLeaseLost: boolean;
  observationBacklogCount: number;
  observationBacklogThreshold: number;
  integrityAuditPassed: boolean | null;
  schedulerLastRunAgeMs: number | null;
  schedulerStalledThresholdMs: number;
  sourcePollFailed: boolean;
  rateLimitStormDetected: boolean;
  settlementStuckCount: number;
  /** The source lane was acquired and wallets ARE configured, but zero wallets were attempted this cycle -- a coverage gap distinct from a single wallet's poll failing. */
  sourceCoverageGap: boolean;
  /** CODEX P1-1 (round 2): at least one wallet ACTUALLY POLLED this cycle ended with an unresolved source-coverage gap (source-poll.server.ts's continuous invariant) -- distinct from sourceCoverageGap above (zero wallets attempted at all). */
  sourceCoverageIncomplete: boolean;
  /** CODEX P2-2: at least one 429-cooldown persistence write has genuinely failed (not merely a 429 itself) within the lookback window -- durable rate-limit coordination is degraded, distinct from rateLimitStormDetected (an upstream condition, not a failure of OUR OWN persistence). */
  rateLimitPersistFailureDetected: boolean;
}): AlertCondition[] {
  const alerts: AlertCondition[] = [];
  if (input.pmusDiscoveryFailed) alerts.push({ alertKey: "venue_discovery_failed:PMUS", severity: "WARNING", message: "PM-US discovery has failed", kind: "sports_shadow_venue_starved" });
  if (input.kalshiDiscoveryFailed) alerts.push({ alertKey: "venue_discovery_failed:KALSHI", severity: "WARNING", message: "Kalshi discovery has failed", kind: "sports_shadow_venue_starved" });
  if (input.pmusLeaseLost) alerts.push({ alertKey: "lease_lost:PMUS", severity: "WARNING", message: "PM-US observation lease was lost mid-cycle", kind: "sports_shadow_venue_starved" });
  if (input.kalshiLeaseLost) alerts.push({ alertKey: "lease_lost:KALSHI", severity: "WARNING", message: "Kalshi observation lease was lost mid-cycle", kind: "sports_shadow_venue_starved" });
  if (input.observationBacklogCount > input.observationBacklogThreshold) {
    alerts.push({
      alertKey: "observation_backlog",
      severity: "WARNING",
      message: `Observation backlog (${input.observationBacklogCount}) exceeds threshold (${input.observationBacklogThreshold})`,
      kind: "sports_shadow_observation_backlog",
    });
  }
  if (input.integrityAuditPassed === false) {
    alerts.push({ alertKey: "integrity_audit_failed", severity: "CRITICAL", message: "Daily integrity audit failed", kind: "sports_shadow_integrity_failed" });
  }
  if (input.schedulerLastRunAgeMs !== null && input.schedulerLastRunAgeMs > input.schedulerStalledThresholdMs) {
    alerts.push({
      alertKey: "scheduler_stopped",
      severity: "CRITICAL",
      message: `Scheduler has not run in ${Math.round(input.schedulerLastRunAgeMs / 1000)}s`,
      kind: "sports_shadow_scheduler_stopped",
    });
  }
  if (input.sourcePollFailed) alerts.push({ alertKey: "source_unhealthy", severity: "WARNING", message: "Source wallet polling failed", kind: "sports_shadow_source_unhealthy" });
  if (input.rateLimitStormDetected) alerts.push({ alertKey: "rate_limit_storm", severity: "WARNING", message: "Sustained 429/cooldown activity detected", kind: "sports_shadow_rate_limit_storm" });
  if (input.settlementStuckCount > 0) {
    alerts.push({ alertKey: "settlement_stuck", severity: "WARNING", message: `${input.settlementStuckCount} settlement(s) stuck PENDING beyond expected timing`, kind: "sports_shadow_settlement_stuck" });
  }
  if (input.sourceCoverageGap) {
    alerts.push({ alertKey: "source_coverage_gap", severity: "WARNING", message: "Source lane ran but attempted zero configured wallets this cycle", kind: "sports_shadow_source_coverage_gap" });
  }
  if (input.sourceCoverageIncomplete) {
    alerts.push({
      alertKey: "source_coverage_incomplete",
      severity: "WARNING",
      message: "At least one polled wallet has an unresolved source-coverage gap -- blocks all research-stage progression",
      kind: "sports_shadow_source_coverage_gap",
    });
  }
  if (input.rateLimitPersistFailureDetected) {
    alerts.push({ alertKey: "rate_limit_persist_failed", severity: "WARNING", message: "A 429-cooldown persistence write has failed -- durable rate-limit coordination is degraded", kind: "sports_shadow_rate_limit_storm" });
  }
  return alerts;
}
