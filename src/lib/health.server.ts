/**
 * Compact PASS / WARN / FAIL self-check for the autonomous shadow bot.
 * Read-only: it never mutates state and never touches trading endpoints.
 */

import { supabaseAdmin } from "@/integrations/supabase/client.server";

import { GENERAL_SHADOW_POLLING_ENABLED, isGeneralShadowName } from "./general-shadow";
import { DATA_API_HOST, getHostCooldown, reserveRequestSlot } from "./http-rate-limit.server";
import { MARK_MAX_AGE_MS } from "./shadow-core";
import { classifyWorker, findAbandonedWorkers, type WorkerRow } from "./worker-health";

export type CheckStatus = "PASS" | "WARN" | "FAIL";

export type HealthCheck = {
  id: string;
  label: string;
  status: CheckStatus;
  detail: string;
};

export type HealthReport = {
  generatedAt: string;
  overall: CheckStatus;
  checks: HealthCheck[];
};

const PUBLIC_DATA_API = "https://data-api.polymarket.com/trades?limit=1";
const HEALTH_HTTP_TIMEOUT_MS = 8_000;
/**
 * Every open dashboard tab polls runSelfCheck on its own client-side timer
 * (independent of, and uncoordinated with, the server-side ingest cron), so
 * without a shared cache N open tabs means N independent pings against
 * data-api.polymarket.com every minute — pure overhead, since this check
 * only cares whether the host is reachable, not what it returns. A cache
 * held just under the dashboard's own refetch interval collapses any number
 * of concurrent callers in this process down to one upstream probe per
 * window.
 */
const PUBLIC_API_PROBE_TTL_MS = 55_000;

type PublicApiProbeResult = { status: CheckStatus; detail: string };
/**
 * Caches the in-flight PROMISE, not just the resolved value: a TTL check on
 * a resolved-value cache still lets every caller that arrives before the
 * FIRST one finishes see an empty/expired cache and fire its own request --
 * concurrent dashboard tabs hitting runSelfCheck within the same window
 * would still each issue an upstream probe during the up-to-8s the fetch is
 * in flight. Sharing the promise itself means every concurrent caller
 * within the TTL, including ones that arrive mid-flight, awaits the exact
 * same request instead of starting a new one.
 */
let cachedPublicApiProbe: { at: number; promise: Promise<PublicApiProbeResult> } | null = null;

function probePublicDataApi(): Promise<PublicApiProbeResult> {
  if (cachedPublicApiProbe && Date.now() - cachedPublicApiProbe.at < PUBLIC_API_PROBE_TTL_MS) {
    return cachedPublicApiProbe.promise;
  }
  const startedAt = Date.now();
  const promise = (async (): Promise<PublicApiProbeResult> => {
    // A reachability probe is still a request against a host that may
    // already be rate-limiting this app; respect the same shared cooldown
    // ingestion uses (see shadow.server.ts) instead of continuing to poll
    // through an active 429 condition every TTL window.
    const cooldown = await getHostCooldown(DATA_API_HOST);
    if (cooldown.blocked) {
      return {
        status: "WARN",
        detail: `${DATA_API_HOST} rate-limit cooldown active${
          cooldown.until ? ` until ${cooldown.until.toISOString()}` : ""
        }; probe skipped`,
      };
    }
    // Same atomic pacing reservation ingestion's real /trades calls use (see
    // reserveRequestSlot's doc comment): this probe is cached/TTL'd and
    // cooldown-gated above, but it still shares the same host budget and
    // must not be able to race a concurrent ingestion request past the
    // point where both simultaneously believe the host is healthy. A
    // reservation failure is deliberately reported as WARN, not FAIL: it
    // means OUR coordination is degraded, not that Polymarket itself is
    // unreachable -- conflating the two would misreport an internal
    // hiccup as an upstream outage. Fail-closed either way: no fetch is
    // attempted when a reservation can't be established.
    let waitMs: number;
    try {
      waitMs = await reserveRequestSlot(DATA_API_HOST);
    } catch (err) {
      return {
        status: "WARN",
        detail: `${DATA_API_HOST} request pacing reservation unavailable, probe skipped: ${
          err instanceof Error ? err.message : "unknown error"
        }`,
      };
    }
    try {
      if (waitMs > 0) await new Promise((resolve) => setTimeout(resolve, waitMs));
      const res = await fetch(PUBLIC_DATA_API, {
        headers: { accept: "application/json" },
        signal: AbortSignal.timeout(HEALTH_HTTP_TIMEOUT_MS),
      });
      return res.ok
        ? { status: "PASS", detail: "Public trades API reachable" }
        : { status: "WARN", detail: `Public trades API returned HTTP ${res.status}` };
    } catch (err) {
      return {
        status: "FAIL",
        detail: err instanceof Error ? err.message : "Public trades API unreachable",
      };
    }
  })();
  cachedPublicApiProbe = { at: startedAt, promise };
  return promise;
}

/** Test-only alias so the shared-promise/cooldown-gated probe can be asserted directly. */
export const probePublicDataApiForTest = probePublicDataApi;
/** Test-only: clears the module-level probe cache between test cases. */
export function resetPublicApiProbeCacheForTest(): void {
  cachedPublicApiProbe = null;
}

function ageSeconds(iso: string | null | undefined): number | null {
  if (!iso) return null;
  return Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 1000));
}

export async function runSelfCheck(): Promise<HealthReport> {
  const checks: HealthCheck[] = [];

  // 1. Database reachability
  const { count: eventCount, error: dbError } = await supabaseAdmin
    .from("source_events")
    .select("id", { count: "exact", head: true });
  checks.push({
    id: "database",
    label: "Database",
    status: dbError ? "FAIL" : "PASS",
    detail: dbError ? dbError.message : `Reachable — ${eventCount ?? 0} persisted source fills`,
  });

  // 2. Enabled experiments
  const { data: experiments, error: experimentsError } = await supabaseAdmin
    .from("paper_experiments")
    .select("id, name, enabled")
    .eq("enabled", true);
  const enabled = experiments?.length ?? 0;
  checks.push({
    id: "experiments",
    label: "Enabled experiments",
    status: experimentsError ? "FAIL" : enabled === 0 ? "FAIL" : enabled < 2 ? "WARN" : "PASS",
    detail: experimentsError
      ? experimentsError.message
      : enabled === 0
        ? "No experiment is enabled"
        : `${enabled} enabled: ${(experiments ?? []).map((e) => e.name).join(", ")}`,
  });

  // 3. Required workers — judged on COMPLETED cycles, never on heartbeat alone.
  const { data: statuses, error: statusesError } = await supabaseAdmin.from("worker_status").select("*");
  const rows = (statuses ?? []) as unknown as WorkerRow[];
  const ingestRows = rows.filter((s) => s.id.startsWith("ingest"));
  // General Shadow experiments stay enabled=true in the DB (the pause is a
  // code-level identity gate, not a DB flag -- see
  // GENERAL_SHADOW_POLLING_ENABLED's own doc comment for why). While that
  // gate is active, runExperimentCycle returns before ever acquiring a
  // lease or touching worker_status for them, so they can never complete a
  // cycle -- counting them as required here would misreport an
  // intentional, reversible pause as a genuine FAIL. Excluded ONLY while
  // the pause is active: flipping GENERAL_SHADOW_POLLING_ENABLED back to
  // true makes them required again, same as any other experiment.
  const requiredExperiments = (experiments ?? []).filter(
    (e) => GENERAL_SHADOW_POLLING_ENABLED || !isGeneralShadowName(e.name),
  );
  const requiredIds = requiredExperiments.map((e) =>
    e.name === "SHADOW" ? "ingest" : `ingest:${e.id}`,
  );
  const nowMs = Date.now();
  const verdicts = requiredIds.map((id) => classifyWorker(rows.find((r) => r.id === id), nowMs));
  const worst: CheckStatus = verdicts.some((v) => v.status === "FAIL")
    ? "FAIL"
    : verdicts.some((v) => v.status === "WARN")
      ? "WARN"
      : "PASS";
  const problem = verdicts.filter((v) => v.status !== "PASS");
  checks.push({
    id: "schedule",
    label: "Required worker cycles",
    status: statusesError ? "FAIL" : verdicts.length === 0 ? "FAIL" : worst,
    detail: statusesError
      ? statusesError.message
      : verdicts.length === 0
        ? "No required worker rows"
        : problem.length === 0
          ? `All ${verdicts.length} required worker(s) completed a cycle recently`
          : problem.map((v) => `${v.id}: ${v.reason}`).join("; "),
  });

  // 4. Abandoned cycles — a killed cycle must not read as healthy.
  const abandoned = findAbandonedWorkers(ingestRows, nowMs);
  checks.push({
    id: "lease",
    label: "Worker lease recovery",
    status: statusesError ? "FAIL" : abandoned.length > 0 ? "WARN" : "PASS",
    detail: statusesError
      ? statusesError.message
      : abandoned.length > 0
        ? `${abandoned.length} abandoned cycle(s) pending reclaim: ${abandoned.map((a) => a.id).join(", ")}`
        : "No abandoned cycles; leases expire and are reacquired atomically",
  });

  // 5. Ingestion errors
  const failing = ingestRows.filter((s) => s.state === "error" || s.poll_failures > 0);
  checks.push({
    id: "ingestion",
    label: "Ingestion errors",
    status: statusesError
      ? "FAIL"
      : failing.length === 0
        ? "PASS"
        : failing.some((s) => s.poll_failures >= 5)
          ? "FAIL"
          : "WARN",
    detail: statusesError
      ? statusesError.message
      : failing.length === 0
        ? "No recent ingestion failures"
        : failing.map((s) => `${s.id}: ${s.poll_failures} failure(s)`).join(", "),
  });

  // 6. Source ingestion freshness
  const { data: newestEvent } = await supabaseAdmin
    .from("source_events")
    .select("first_seen_at")
    .order("first_seen_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  const sourceAge = ageSeconds(newestEvent?.first_seen_at ?? null);
  checks.push({
    id: "source_freshness",
    label: "Source ingestion freshness",
    status: sourceAge === null ? "FAIL" : sourceAge > 86_400 ? "FAIL" : sourceAge > 21_600 ? "WARN" : "PASS",
    detail:
      sourceAge === null
        ? "No source fills persisted"
        : `Newest persisted source fill ${Math.round(sourceAge / 60)} min old`,
  });

  // 7. Settlement health — unacknowledged settlement warnings/errors
  const { data: settlementAlerts } = await supabaseAdmin
    .from("alerts")
    .select("level, kind, created_at")
    .eq("acknowledged", false)
    .gte("created_at", new Date(Date.now() - 6 * 3600_000).toISOString());
  const settlementIssues = (settlementAlerts ?? []).filter(
    (a) => a.kind.includes("settle") || a.kind.includes("resolution"),
  );
  checks.push({
    id: "settlement",
    label: "Settlement",
    status: settlementIssues.some((a) => a.level === "error")
      ? "FAIL"
      : settlementIssues.length > 0
        ? "WARN"
        : "PASS",
    detail:
      settlementIssues.length === 0
        ? "No unresolved settlement warnings in the last 6h"
        : `${settlementIssues.length} open settlement alert(s)`,
  });

  // 8. Mark freshness required for risk/equity calculations
  const { data: openPositions } = await supabaseAdmin
    .from("paper_positions")
    .select("shares, mark, mark_ts")
    .gt("shares", 0);
  const open = openPositions ?? [];
  const fresh = open.filter(
    (p) =>
      p.mark !== null &&
      p.mark_ts !== null &&
      Date.now() - new Date(p.mark_ts).getTime() <= MARK_MAX_AGE_MS,
  ).length;
  const coverage = open.length === 0 ? 100 : Math.round((fresh / open.length) * 1000) / 10;
  checks.push({
    id: "marks",
    label: "Mark freshness (risk/equity)",
    status: open.length === 0 ? "PASS" : coverage >= 99.9 ? "PASS" : coverage > 0 ? "WARN" : "FAIL",
    detail:
      open.length === 0
        ? "No open paper positions to mark"
        : `${fresh}/${open.length} open positions marked within ${Math.round(MARK_MAX_AGE_MS / 1000)}s (${coverage}%)`,
  });

  // 9. Public Polymarket data API (shared across concurrent callers — see probePublicDataApi)
  const { status: publicStatus, detail: publicDetail } = await probePublicDataApi();
  checks.push({
    id: "public_api",
    label: "Polymarket public API",
    status: publicStatus,
    detail: publicDetail,
  });

  // 7. Polymarket US authenticated capability (preview-only)
  const { data: integration, error: integrationError } = await supabaseAdmin
    .from("integration_status")
    .select("*")
    .eq("id", "polymarket_us")
    .maybeSingle();
  checks.push({
    id: "pmus",
    label: "Polymarket US (preview only)",
    status: integrationError ? "FAIL" : integration?.connected ? "PASS" : "WARN",
    detail: integrationError
      ? integrationError.message
      : integration?.connected
        ? `Connected — ${integration.detail ?? "balances/positions/preview only"}`
        : integration?.configured
          ? `Configured but not verified — ${integration.detail ?? "run verification"}`
          : "Credentials not configured — previews stay unavailable",
  });

  const overall: CheckStatus = checks.some((c) => c.status === "FAIL")
    ? "FAIL"
    : checks.some((c) => c.status === "WARN")
      ? "WARN"
      : "PASS";

  return { generatedAt: new Date().toISOString(), overall, checks };
}
