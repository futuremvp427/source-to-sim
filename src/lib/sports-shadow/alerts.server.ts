/**
 * FINAL BUILD Part 27: actionable alerting — SERVER (DB) layer.
 *
 * HONEST LIMITATION: Part 27 says "reuse the project's existing notification/alert
 * infrastructure." A repo-wide search (this session, 2026-08-22) for any existing
 * email/Slack/webhook/push delivery mechanism found NONE anywhere in this codebase --
 * every other experiment in this repo has no alerting channel to reuse either. This
 * module therefore implements ONLY the durable, deduplicated ALERT RECORD layer
 * (sports_shadow_alerts, already migrated) -- raising/resolving alerts idempotently so
 * a sustained condition never spams a new row every cycle. It does NOT invent a new
 * external delivery integration (email/Slack/etc.) on its own initiative, since that
 * would require new credentials/services this task was never asked to provision.
 * Wiring a real delivery channel once one exists in this project is a small, isolated
 * follow-up: call `raiseAlert`/`resolveAlert` from wherever that channel's send
 * function lives.
 */

import { supabaseAdmin } from "@/integrations/supabase/client.server";

export type AlertSeverity = "INFO" | "WARNING" | "CRITICAL";

export type AlertRepository = {
  /** Idempotent: a second raise under the SAME alertKey while one is still unresolved is a no-op (the UNIQUE partial index on sports_shadow_alerts enforces this at the DB level too -- this checks first to avoid a noisy constraint-violation round trip every cycle). */
  raise(alertKey: string, severity: AlertSeverity, message: string): Promise<{ raised: boolean }>;
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
    if (await this.hasUnresolved(alertKey)) return { raised: false };
    const { error } = await supabaseAdmin.from("sports_shadow_alerts" as never).insert({ alert_key: alertKey, severity, message } as never);
    if (error) throw new Error(error.message);
    return { raised: true };
  },
  async resolve(alertKey) {
    const { error } = await supabaseAdmin.from("sports_shadow_alerts" as never).update({ resolved_at: new Date().toISOString() } as never).eq("alert_key", alertKey).is("resolved_at", null);
    if (error) throw new Error(error.message);
  },
};

/** Best-effort: an alerting failure must never break the operation that triggered it. */
export async function raiseAlert(alertKey: string, severity: AlertSeverity, message: string, repo: AlertRepository = supabaseAlertRepository): Promise<void> {
  try {
    await repo.raise(alertKey, severity, message);
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
 * Evaluates the fixed set of meaningful conditions Part 27 lists against ALREADY-
 * COMPUTED inputs (a cycle summary, an integrity audit result) -- never queries
 * anything itself, so it stays trivially testable and has zero extra DB round trips
 * beyond what the caller already paid for. Deliberately does NOT alert on ordinary
 * per-trade activity (Part 27's own "avoid trade-by-trade noise" rule).
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
}): { alertKey: string; severity: AlertSeverity; message: string }[] {
  const alerts: { alertKey: string; severity: AlertSeverity; message: string }[] = [];
  if (input.pmusDiscoveryFailed) alerts.push({ alertKey: "venue_discovery_failed:PMUS", severity: "WARNING", message: "PM-US discovery has failed" });
  if (input.kalshiDiscoveryFailed) alerts.push({ alertKey: "venue_discovery_failed:KALSHI", severity: "WARNING", message: "Kalshi discovery has failed" });
  if (input.pmusLeaseLost) alerts.push({ alertKey: "lease_lost:PMUS", severity: "WARNING", message: "PM-US observation lease was lost mid-cycle" });
  if (input.kalshiLeaseLost) alerts.push({ alertKey: "lease_lost:KALSHI", severity: "WARNING", message: "Kalshi observation lease was lost mid-cycle" });
  if (input.observationBacklogCount > input.observationBacklogThreshold) {
    alerts.push({ alertKey: "observation_backlog", severity: "WARNING", message: `Observation backlog (${input.observationBacklogCount}) exceeds threshold (${input.observationBacklogThreshold})` });
  }
  if (input.integrityAuditPassed === false) alerts.push({ alertKey: "integrity_audit_failed", severity: "CRITICAL", message: "Daily integrity audit failed" });
  if (input.schedulerLastRunAgeMs !== null && input.schedulerLastRunAgeMs > input.schedulerStalledThresholdMs) {
    alerts.push({ alertKey: "scheduler_stopped", severity: "CRITICAL", message: `Scheduler has not run in ${Math.round(input.schedulerLastRunAgeMs / 1000)}s` });
  }
  return alerts;
}
