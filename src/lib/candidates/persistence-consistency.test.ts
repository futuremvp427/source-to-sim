import { describe, expect, it, vi } from "vitest";

/**
 * Bounded oldest-first research means MOST candidates are intentionally not
 * refreshed by any given run. The persistence invariant is therefore
 * per-candidate INTERNAL alignment (metrics/fingerprint/score from the same
 * run), never freshness relative to the latest global worker run. A resolved
 * candidate with no artifacts yet is a valid NOT_SCORED row until its bounded
 * research turn arrives.
 */

type Row = Record<string, unknown>;

const db = {
  watchlist: [] as Row[],
  metrics: [] as Row[],
  fingerprint: [] as Row[],
  scores: [] as Row[],
};
const workerWrites: Row[] = [];

function from(table: string) {
  const b: Record<string, unknown> = {};
  for (const m of ["select", "eq", "is", "in", "order", "limit", "maybeSingle"]) b[m] = () => b;
  b["update"] = (payload: Row) => {
    if (table === "worker_status") workerWrites.push(payload);
    return b;
  };
  b["then"] = (res: (v: unknown) => unknown) => {
    const data =
      table === "candidate_watchlist"
        ? db.watchlist
        : table === "candidate_metrics"
          ? db.metrics
          : table === "candidate_fingerprint"
            ? db.fingerprint
            : table === "candidate_scores"
              ? db.scores
              : [];
    return Promise.resolve({ data, error: null }).then(res);
  };
  return b;
}

vi.mock("@/integrations/supabase/client.server", () => ({ supabaseAdmin: { from } }));

const { evaluateCandidatePersistence, verifyCandidateResearchPersistence } = await import("./consistency.server");
const { selectResearchBatch } = await import("./research-batch");

const RUN_A = "2026-08-16T18:27:43.000Z"; // older run
const RUN_B = "2026-08-16T21:03:38.000Z"; // latest bounded run

function candidate(handle: string, at: string | null, overrides: Partial<Record<"metrics" | "fingerprint" | "score", string | null>> = {}): void {
  db.watchlist.push({ id: handle, handle, wallet: `0x${handle}` });
  const push = (target: Row[], key: "metrics" | "fingerprint" | "score") => {
    const value = key in overrides ? overrides[key] : at;
    if (value) target.push({ candidate_id: handle, computed_at: value });
  };
  push(db.metrics, "metrics");
  push(db.fingerprint, "fingerprint");
  push(db.scores, "score");
}

function reset(): void {
  db.watchlist = [];
  db.metrics = [];
  db.fingerprint = [];
  db.scores = [];
  workerWrites.length = 0;
}

describe("candidate persistence consistency under bounded rotation", () => {
  it("passes when two candidates are freshly researched and the rest are older but internally aligned", async () => {
    reset();
    candidate("e46m3", RUN_B);
    candidate("badatmath.", RUN_B);
    candidate("older1", RUN_A);
    candidate("older2", "2026-08-15T09:00:00.000Z");
    candidate("older3", "2026-08-10T09:00:00.000Z");

    const check = await verifyCandidateResearchPersistence({ downgradeRunState: true });
    expect(check.ok).toBe(true);
    expect(check.issues).toEqual([]);
    expect(check.expectedCandidates).toBe(5);
    expect(workerWrites).toHaveLength(0);
  });

  it("treats a resolved candidate with zero artifacts as valid NOT_SCORED", async () => {
    reset();
    candidate("new-wallet", null);

    expect(
      evaluateCandidatePersistence({ metrics: null, fingerprint: null, score: null }),
    ).toEqual({ missing: [], stale: [] });

    const check = await verifyCandidateResearchPersistence({ downgradeRunState: true });
    expect(check.ok).toBe(true);
    expect(check.issues).toEqual([]);
    expect(check.expectedCandidates).toBe(1);
    expect(workerWrites).toHaveLength(0);
  });

  it("passes when all three artifacts come from the same older run", async () => {
    reset();
    candidate("old", RUN_A, {
      metrics: RUN_A,
      fingerprint: "2026-08-16T18:27:45.000Z", // inside the 5s slop
      score: "2026-08-16T18:27:46.500Z",
    });
    const check = await verifyCandidateResearchPersistence();
    expect(check.ok).toBe(true);
  });

  it("fails when research has begun but an artifact is missing", async () => {
    reset();
    candidate("nofp", RUN_A, { fingerprint: null });
    const direct = evaluateCandidatePersistence({
      metrics: RUN_A,
      fingerprint: null,
      score: RUN_A,
    });
    expect(direct.missing).toEqual(["fingerprint"]);

    const check = await verifyCandidateResearchPersistence();
    expect(check.ok).toBe(false);
    expect(check.issues[0]).toMatchObject({ handle: "nofp", missing: ["fingerprint"] });
  });

  it("fails and identifies the mixed-version candidate when metrics are minutes newer", async () => {
    reset();
    candidate("fresh", RUN_B);
    candidate("opopv.", RUN_A, { metrics: "2026-08-16T18:36:57.010Z" });
    const check = await verifyCandidateResearchPersistence({ downgradeRunState: true });
    expect(check.ok).toBe(false);
    expect(check.issues).toHaveLength(1);
    expect(check.issues[0]).toMatchObject({
      handle: "opopv.",
      missing: [],
      stale: ["fingerprint", "score"],
    });
    expect(String(workerWrites.at(-1)?.["last_error"])).toContain("opopv.");
  });

  it("passes once the inconsistent candidate is rewritten with aligned timestamps", async () => {
    reset();
    candidate("opopv.", RUN_B);
    const check = await verifyCandidateResearchPersistence();
    expect(check.ok).toBe(true);
  });
});

describe("bounded batch prioritizes repair candidates", () => {
  const candidates = [
    { id: "a", handle: "a" },
    { id: "b", handle: "b" },
    { id: "c", handle: "c" },
    { id: "d", handle: "d" },
  ];

  it("selects inconsistent/missing candidates ahead of ordinary oldest-first ones", () => {
    const lastComputed = new Map<string, string | null>([
      ["a", "2026-08-01T00:00:00.000Z"], // oldest
      ["b", "2026-08-05T00:00:00.000Z"],
      ["c", "2026-08-10T00:00:00.000Z"],
      ["d", null], // never computed
    ]);
    expect(selectResearchBatch(candidates, lastComputed, 2, new Set(["c"])).map((x) => x.id)).toEqual([
      "c",
      "d",
    ]);
    expect(selectResearchBatch(candidates, lastComputed, 2).map((x) => x.id)).toEqual(["d", "a"]);
  });
});
