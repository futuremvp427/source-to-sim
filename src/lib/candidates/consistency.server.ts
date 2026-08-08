import { supabaseAdmin } from "@/integrations/supabase/client.server";

const RESEARCH_WORKER_ID = "candidate_research";
const FRESHNESS_SLOP_MS = 5_000;

export type CandidatePersistenceIssue = {
  candidateId: string;
  handle: string;
  missing: string[];
  stale: string[];
};

export type CandidatePersistenceCheck = {
  ok: boolean;
  checkedAt: string;
  expectedCandidates: number;
  issues: CandidatePersistenceIssue[];
};

type WatchRow = {
  id: string;
  handle: string;
  wallet: string | null;
};

type ComputedRow = {
  candidate_id: string;
  computed_at: string;
};

/**
 * Verifies the persisted research invariant after a research pass:
 * every resolved candidate must have metrics, fingerprint and score rows whose
 * computed_at is at least as fresh as the recorded run timestamp.
 *
 * This is intentionally separate from the research engine so it can guard both
 * manual and scheduled entry points without changing scoring math.
 */
export async function verifyCandidateResearchPersistence(options: {
  downgradeRunState?: boolean;
} = {}): Promise<CandidatePersistenceCheck> {
  const [watchRes, metricsRes, fingerprintRes, scoresRes, workerRes] = await Promise.all([
    supabaseAdmin.from("candidate_watchlist").select("id, handle, wallet"),
    supabaseAdmin.from("candidate_metrics").select("candidate_id, computed_at"),
    supabaseAdmin.from("candidate_fingerprint").select("candidate_id, computed_at"),
    supabaseAdmin.from("candidate_scores").select("candidate_id, computed_at"),
    supabaseAdmin
      .from("worker_status")
      .select("last_poll_at")
      .eq("id", RESEARCH_WORKER_ID)
      .maybeSingle(),
  ]);

  for (const [label, res] of [
    ["candidate_watchlist", watchRes],
    ["candidate_metrics", metricsRes],
    ["candidate_fingerprint", fingerprintRes],
    ["candidate_scores", scoresRes],
    ["worker_status", workerRes],
  ] as const) {
    if (res.error) throw new Error(`${label} consistency read failed: ${res.error.message}`);
  }

  const expected = ((watchRes.data ?? []) as WatchRow[]).filter((row) => Boolean(row.wallet));
  const runAt = workerRes.data?.last_poll_at ? new Date(workerRes.data.last_poll_at).getTime() : null;
  const freshnessFloor = runAt === null ? null : runAt - FRESHNESS_SLOP_MS;

  const mapByCandidate = (rows: unknown[] | null): Map<string, string> =>
    new Map(
      ((rows ?? []) as ComputedRow[]).map((row) => [row.candidate_id, row.computed_at]),
    );

  const metrics = mapByCandidate(metricsRes.data);
  const fingerprints = mapByCandidate(fingerprintRes.data);
  const scores = mapByCandidate(scoresRes.data);
  const issues: CandidatePersistenceIssue[] = [];

  for (const row of expected) {
    const missing: string[] = [];
    const stale: string[] = [];
    for (const [label, map] of [
      ["metrics", metrics],
      ["fingerprint", fingerprints],
      ["score", scores],
    ] as const) {
      const computedAt = map.get(row.id);
      if (!computedAt) {
        missing.push(label);
        continue;
      }
      if (freshnessFloor !== null) {
        const computedMs = new Date(computedAt).getTime();
        if (!Number.isFinite(computedMs) || computedMs < freshnessFloor) stale.push(label);
      }
    }
    if (missing.length > 0 || stale.length > 0) {
      issues.push({ candidateId: row.id, handle: row.handle, missing, stale });
    }
  }

  const check: CandidatePersistenceCheck = {
    ok: issues.length === 0,
    checkedAt: new Date().toISOString(),
    expectedCandidates: expected.length,
    issues,
  };

  if (!check.ok && options.downgradeRunState) {
    const detail = issues
      .slice(0, 10)
      .map((i) => `${i.handle}: missing=${i.missing.join("|") || "none"}, stale=${i.stale.join("|") || "none"}`)
      .join("; ")
      .slice(0, 400);
    await supabaseAdmin
      .from("worker_status")
      .update({
        state: "partial",
        last_error: `candidate persistence consistency failed: ${detail}`,
        updated_at: new Date().toISOString(),
      } as never)
      .eq("id", RESEARCH_WORKER_ID);
  }

  return check;
}
