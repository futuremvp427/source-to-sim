/**
 * Compact PASS / WARN / FAIL self-check for the autonomous shadow bot.
 * Read-only: it never mutates state and never touches trading endpoints.
 */

import { supabaseAdmin } from "@/integrations/supabase/client.server";

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

const STALE_HEARTBEAT_SECONDS = 300;
const PUBLIC_DATA_API = "https://data-api.polymarket.com/trades?limit=1";
const HEALTH_HTTP_TIMEOUT_MS = 8_000;

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
  const requiredIds = (experiments ?? []).map((e) =>
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

  // 6. Public Polymarket data API
  let publicStatus: CheckStatus = "PASS";
  let publicDetail = "Public trades API reachable";
  try {
    const res = await fetch(PUBLIC_DATA_API, {
      headers: { accept: "application/json" },
      signal: AbortSignal.timeout(HEALTH_HTTP_TIMEOUT_MS),
    });
    if (!res.ok) {
      publicStatus = "WARN";
      publicDetail = `Public trades API returned HTTP ${res.status}`;
    }
  } catch (err) {
    publicStatus = "FAIL";
    publicDetail = err instanceof Error ? err.message : "Public trades API unreachable";
  }
  checks.push({ id: "public_api", label: "Polymarket public API", status: publicStatus, detail: publicDetail });

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
