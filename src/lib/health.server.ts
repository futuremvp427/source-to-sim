/**
 * Compact PASS / WARN / FAIL self-check for the autonomous shadow bot.
 * Read-only: it never mutates state and never touches trading endpoints.
 */

import { supabaseAdmin } from "@/integrations/supabase/client.server";

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
  const { data: experiments } = await supabaseAdmin
    .from("paper_experiments")
    .select("id, name, enabled")
    .eq("enabled", true);
  const enabled = experiments?.length ?? 0;
  checks.push({
    id: "experiments",
    label: "Enabled experiments",
    status: enabled === 0 ? "FAIL" : enabled < 2 ? "WARN" : "PASS",
    detail: enabled === 0 ? "No experiment is enabled" : `${enabled} enabled: ${(experiments ?? []).map((e) => e.name).join(", ")}`,
  });

  // 3. Scheduled cycle / heartbeat freshness
  const { data: statuses } = await supabaseAdmin.from("worker_status").select("*");
  const ingestRows = (statuses ?? []).filter((s) => s.id.startsWith("ingest"));
  const freshest = ingestRows
    .map((s) => ageSeconds(s.heartbeat_at))
    .filter((v): v is number => v !== null)
    .sort((a, b) => a - b)[0];
  checks.push({
    id: "schedule",
    label: "Scheduled polling",
    status: freshest === undefined ? "FAIL" : freshest > STALE_HEARTBEAT_SECONDS ? "WARN" : "PASS",
    detail:
      freshest === undefined
        ? "No worker heartbeat recorded"
        : `Last heartbeat ${freshest}s ago across ${ingestRows.length} worker row(s)`,
  });

  // 4. Lease health — no stuck leases
  const stuck = ingestRows.filter(
    (s) => s.state === "running" && (ageSeconds(s.heartbeat_at) ?? 0) > STALE_HEARTBEAT_SECONDS,
  );
  checks.push({
    id: "lease",
    label: "Worker lease",
    status: stuck.length > 0 ? "WARN" : "PASS",
    detail: stuck.length > 0 ? `${stuck.length} stale lease(s) will expire and be retaken` : "No stale leases",
  });

  // 5. Ingestion errors
  const failing = ingestRows.filter((s) => s.state === "error" || s.poll_failures > 0);
  checks.push({
    id: "ingestion",
    label: "Ingestion errors",
    status: failing.length === 0 ? "PASS" : failing.some((s) => s.poll_failures >= 5) ? "FAIL" : "WARN",
    detail:
      failing.length === 0
        ? "No recent ingestion failures"
        : failing.map((s) => `${s.id}: ${s.poll_failures} failure(s)`).join(", "),
  });

  // 6. Public Polymarket data API
  let publicStatus: CheckStatus = "PASS";
  let publicDetail = "Public trades API reachable";
  try {
    const res = await fetch(PUBLIC_DATA_API, { headers: { accept: "application/json" } });
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
  const { data: integration } = await supabaseAdmin
    .from("integration_status")
    .select("*")
    .eq("id", "polymarket_us")
    .maybeSingle();
  checks.push({
    id: "pmus",
    label: "Polymarket US (preview only)",
    status: integration?.connected ? "PASS" : integration?.configured ? "WARN" : "WARN",
    detail: integration?.connected
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
