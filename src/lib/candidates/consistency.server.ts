import { supabaseAdmin } from "@/integrations/supabase/client.server";

const RESEARCH_WORKER_ID = "candidate_research";
/** Artifacts written by one research pass land within a few seconds of each other. */
export const ARTIFACT_ALIGNMENT_SLOP_MS = 5_000;

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
 * Pure per-candidate persistence invariant.
 *
 * Research is BOUNDED and resumable (oldest-first rotation), so a candidate
 * being old is expected and valid. What is NOT valid is a candidate whose three
 * artifacts come from different runs ("mixed version"), or a candidate missing
 * an artifact entirely. Therefore the invariant is INTERNAL alignment of each
 * candidate's own metrics/fingerprint/score timestamps, never freshness
 * relative to the latest global worker run.
 */
export function evaluateCandidatePersistence(
  artifacts: { metrics?: string | null; fingerprint?: string | null; score?: string | null },
  slopMs: number = ARTIFACT_ALIGNMENT_SLOP_MS,
): { missing: string[]; stale: string[] } {
  const missing: string[] = [];
  const times = new Map<string, number>();
  for (const [label, value] of [
    ["metrics", artifacts.metrics],
    ["fingerprint", artifacts.fingerprint],
    ["score", artifacts.score],
  ] as const) {
    if (!value) {
      missing.push(label);
      continue;
    }
    const ms = new Date(value).getTime();
    if (!Number.isFinite(ms)) {
      missing.push(label);
      continue;
    }
    times.set(label, ms);
  }
  const stale: string[] = [];
  if (missing.length === 0) {
    const newest = Math.max(...times.values());
    for (const [label, ms] of times) {
      if (newest - ms > slopMs) stale.push(label);
    }
  }
  return { missing, stale: stale.sort() };
}

/**
 * Verifies the persisted research invariant across all resolved candidates,
 * using the per-candidate internal alignment rule above. Intentionally separate
 * from the research engine so it can guard both manual and scheduled entry
 * points without changing scoring math.
 */
export async function verifyCandidateResearchPersistence(options: {
  downgradeRunState?: boolean;
} = {}): Promise<CandidatePersistenceCheck> {
  const [watchRes, metricsRes, fingerprintRes, scoresRes] = await Promise.all([
    supabaseAdmin.from("candidate_watchlist").select("id, handle, wallet"),
    supabaseAdmin.from("candidate_metrics").select("candidate_id, computed_at"),
    supabaseAdmin.from("candidate_fingerprint").select("candidate_id, computed_at"),
    supabaseAdmin.from("candidate_scores").select("candidate_id, computed_at"),
  ]);

  for (const [label, res] of [
    ["candidate_watchlist", watchRes],
    ["candidate_metrics", metricsRes],
    ["candidate_fingerprint", fingerprintRes],
    ["candidate_scores", scoresRes],
  ] as const) {
    if (res.error) throw new Error(`${label} consistency read failed: ${res.error.message}`);
  }

  const expected = ((watchRes.data ?? []) as WatchRow[]).filter((row) => Boolean(row.wallet));

  const mapByCandidate = (rows: unknown[] | null): Map<string, string> =>
    new Map(
      ((rows ?? []) as ComputedRow[]).map((row) => [row.candidate_id, row.computed_at]),
    );

  const metrics = mapByCandidate(metricsRes.data);
  const fingerprints = mapByCandidate(fingerprintRes.data);
  const scores = mapByCandidate(scoresRes.data);
  const issues: CandidatePersistenceIssue[] = [];

  for (const row of expected) {
    const { missing, stale } = evaluateCandidatePersistence({
      metrics: metrics.get(row.id),
      fingerprint: fingerprints.get(row.id),
      score: scores.get(row.id),
    });
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
