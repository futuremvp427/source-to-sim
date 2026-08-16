import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Proves the autonomous candidate research pass is bounded END-TO-END: the
 * overall wall-clock deadline starts immediately after the lease (before any
 * seeding, handle resolution or reference fingerprint), every public HTTP call
 * is abortable by that deadline, unresolved-handle resolution is bounded per
 * invocation, and an exhausted budget still records a terminal run state
 * instead of leaving worker_status stuck at 'running' until lease expiry.
 */

type Row = Record<string, unknown>;

const RESEARCH_BUDGET_MS = 120_000;

type DbConfig = {
  watchlist: Row[];
  metricsRows?: Row[];
  metricsReadError?: string;
  metricsWriteError?: string;
  workerWriteError?: string;
  watchlistNoteWriteError?: string;
  /** Called when the watchlist read resolves — used to burn wall-clock time. */
  onWatchlistRead?: () => void;
};

let config: DbConfig = { watchlist: [] };
const writes: { table: string; op: string; payload: Row }[] = [];

function result(table: string, op: string): { data: unknown; error: { message: string } | null } {
  if (table === "candidate_watchlist" && op === "select") {
    config.onWatchlistRead?.();
    return { data: config.watchlist, error: null };
  }
  if (table === "candidate_metrics" && op === "select") {
    if (config.metricsReadError) return { data: null, error: { message: config.metricsReadError } };
    return { data: config.metricsRows ?? [], error: null };
  }
  if (table === "candidate_metrics" && op === "upsert" && config.metricsWriteError) {
    return { data: null, error: { message: config.metricsWriteError } };
  }
  if (table === "worker_status" && op === "update" && config.workerWriteError) {
    return { data: null, error: { message: config.workerWriteError } };
  }
  if (table === "candidate_watchlist" && op === "update" && config.watchlistNoteWriteError) {
    return { data: null, error: { message: config.watchlistNoteWriteError } };
  }
  if (table === "worker_status" && op === "select") return { data: null, error: null };
  return { data: [], error: null };
}

function from(table: string) {
  const st = { op: "select" };
  const b: Record<string, unknown> = {};
  const passthrough = ["select", "eq", "is", "in", "gte", "lt", "order", "limit", "maybeSingle"];
  for (const m of passthrough) b[m] = () => b;
  for (const m of ["insert", "update", "upsert"] as const) {
    b[m] = (payload: Row) => {
      st.op = m;
      writes.push({ table, op: m, payload });
      return b;
    };
  }
  b["then"] = (res: (v: unknown) => unknown, rej?: (e: unknown) => unknown) =>
    Promise.resolve(result(table, st.op)).then(res, rej);
  return b;
}

vi.mock("@/integrations/supabase/client.server", () => ({
  supabaseAdmin: {
    from,
    rpc: async () => ({ data: "worker-1", error: null }),
  },
}));

const { runCandidateResearch, resolveBoundedUnresolved } = await import("./research.server");
const { selectUnresolvedForResolution, UNRESOLVED_RESOLUTIONS_PER_RUN } = await import("./research-batch");

const fetchCalls: string[] = [];

function mockFetch(opts: { hang?: boolean; hangOn?: string; trades?: unknown[] } = {}): void {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: { signal?: AbortSignal }) => {
      fetchCalls.push(String(url));
      if (opts.hang || (opts.hangOn && String(url).includes(opts.hangOn))) {
        return await new Promise((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => {
            const err = new Error("aborted");
            err.name = "AbortError";
            reject(err);
          });
        });
      }
      const body = String(url).includes("public-search")
        ? { profiles: [] }
        : String(url).includes("prices-history")
          ? { history: [] }
          : String(url).includes("/trades?")
            ? (opts.trades ?? [])
            : [];
      return new Response(JSON.stringify(body), { status: 200 });
    }),
  );
}

const searchCalls = () => fetchCalls.filter((u) => u.includes("public-search"));
const workerWrites = () => writes.filter((w) => w.table === "worker_status");

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-08-16T21:00:00.000Z"));
  fetchCalls.length = 0;
  writes.length = 0;
  config = { watchlist: [] };
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

const resolvedRow = (id: string): Row => ({
  id,
  handle: id,
  wallet: `0x${id.padEnd(40, "0")}`,
  wallet_resolved: true,
  source: "USER_OBSERVED_WEEKLY_LEADERBOARD_SNAPSHOT",
  status: "RESEARCH",
  notes: null,
  weekly_snapshot_rank: 1,
  weekly_snapshot_pnl: 1,
  promoted_experiment_id: null,
  added_at: "2026-08-01T00:00:00.000Z",
  updated_at: "2026-08-01T00:00:00.000Z",
});

const unresolvedRow = (id: string, updatedAt: string | null): Row => ({
  ...resolvedRow(id),
  wallet: null,
  wallet_resolved: false,
  status: "INSUFFICIENT_DATA",
  updated_at: updatedAt,
});

describe("overall deadline starts before seed/reference work", () => {
  it("aborts before any public HTTP call when the budget is consumed during watchlist seeding", async () => {
    mockFetch();
    config = {
      watchlist: [resolvedRow("aaa")],
      // Seeding itself outlives the budget: nothing may reach the network after.
      onWatchlistRead: () => vi.advanceTimersByTime(RESEARCH_BUDGET_MS + 1),
    };

    const summary = await runCandidateResearch();

    expect(fetchCalls).toHaveLength(0);
    expect(summary.researched).toBe(0);
    expect(summary.state).toBe("error");
    expect(summary.detail).toMatch(/budget exhausted/i);
  });

  it("records a terminal run state rather than leaving worker_status 'running'", async () => {
    mockFetch();
    config = {
      watchlist: [resolvedRow("aaa")],
      onWatchlistRead: () => vi.advanceTimersByTime(RESEARCH_BUDGET_MS + 1),
    };

    await runCandidateResearch();

    const last = workerWrites().at(-1);
    expect(last).toBeDefined();
    expect(last!.payload["state"]).toBe("error");
    expect(String(last!.payload["last_error"])).toMatch(/budget exhausted/i);
  });
});

describe("bounded unresolved-handle resolution", () => {
  it("selects at most one unresolved candidate per run, oldest-touched first", () => {
    const rows = [
      { handle: "zz", wallet: null, updated_at: "2026-08-10T00:00:00.000Z" },
      { handle: "aa", wallet: null, updated_at: null },
      { handle: "mm", wallet: "0xabc", updated_at: null },
    ];
    expect(UNRESOLVED_RESOLUTIONS_PER_RUN).toBe(1);
    expect(selectUnresolvedForResolution(rows).map((r) => r.handle)).toEqual(["aa"]);
    expect(selectUnresolvedForResolution(rows, 2).map((r) => r.handle)).toEqual(["aa", "zz"]);
  });

  it("issues one public-search per invocation even with five unresolved handles", async () => {
    mockFetch();
    config = {
      watchlist: [
        unresolvedRow("u1", null),
        unresolvedRow("u2", "2026-08-02T00:00:00.000Z"),
        unresolvedRow("u3", "2026-08-03T00:00:00.000Z"),
        unresolvedRow("u4", "2026-08-04T00:00:00.000Z"),
        unresolvedRow("u5", "2026-08-05T00:00:00.000Z"),
      ],
    };

    await runCandidateResearch();
    expect(searchCalls()).toHaveLength(1);
  });

  it("rotates the unresolved queue by touching updated_at on a failed attempt", async () => {
    mockFetch();
    const rows = [unresolvedRow("u1", null), unresolvedRow("u2", "2026-08-02T00:00:00.000Z")] as never as Parameters<
      typeof resolveBoundedUnresolved
    >[0];
    const out = await resolveBoundedUnresolved(rows);
    expect(out.attempted).toEqual(["u1"]);
    expect(out.resolved).toEqual([]);
    const touched = out.rows.find((r) => r.handle === "u1")!;
    expect(touched.updated_at).toBe(new Date().toISOString());
  });
});

describe("abortable network calls under the overall deadline", () => {
  it("stops a hung public fetch at the deadline and returns a terminal partial/error state", async () => {
    mockFetch({ hang: true });
    config = { watchlist: [resolvedRow("aaa")] };

    const run = runCandidateResearch();
    await vi.advanceTimersByTimeAsync(RESEARCH_BUDGET_MS + 1);
    const summary = await run;

    expect(["error", "partial"]).toContain(summary.state);
    expect(summary.detail).toMatch(/budget exhausted/i);
    expect(workerWrites().at(-1)!.payload["state"]).not.toBe("running");
  });
});

describe("candidate_metrics errors are never silently ignored", () => {
  it("fails the run when the computed_at cursor read errors", async () => {
    mockFetch();
    config = { watchlist: [resolvedRow("aaa")], metricsReadError: "cursor read boom" };

    const summary = await runCandidateResearch();
    expect(summary.state).toBe("error");
    expect(summary.detail).toMatch(/candidate_metrics read failed/);
  });

  it("records a candidate failure when the metrics upsert errors", async () => {
    mockFetch();
    config = { watchlist: [resolvedRow("aaa")], metricsWriteError: "metrics write boom" };

    const summary = await runCandidateResearch();
    expect(summary.researched).toBe(0);
    expect(summary.failures.map((f) => f.error).join(" ")).toMatch(/candidate_metrics write failed/);
  });
});
