import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Proves the ingest scheduler boundary for candidate research CANCELS instead of
 * abandoning: the ~8s scheduler budget aborts in-flight public HTTP, and the
 * helper does not return until the terminal worker_status write has happened,
 * so the 300s research lease can never be left at state='running'.
 */

type Row = Record<string, unknown>;

const writes: { table: string; op: string; payload: Row }[] = [];
let watchlist: Row[] = [];
let runState: Row | null = null;

function result(table: string, op: string): { data: unknown; error: null } {
  if (table === "candidate_watchlist" && op === "select") return { data: watchlist, error: null };
  if (table === "candidate_metrics" && op === "select") return { data: [], error: null };
  if (table === "worker_status" && op === "select") return { data: runState, error: null };
  if (table === "worker_status" && op === "update") return { data: [{ id: "candidate_research" }], error: null };
  return { data: [], error: null };
}

function from(table: string) {
  const st = { op: "select" };
  const b: Record<string, unknown> = {};
  for (const m of ["select", "eq", "is", "in", "gte", "lt", "order", "limit", "maybeSingle"]) b[m] = () => b;
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

/**
 * Chainable so both direct-await callers (acquireResearchLease) and
 * .abortSignal(signal)-chained callers (reserveRequestSlot) work. Grants an
 * immediate reservation by default -- this file is about the scheduler
 * deadline/abort boundary, not reservation pacing/failure.
 */
function chainableRpc(result: { data: unknown; error: unknown }) {
  const builder: {
    abortSignal: (signal: AbortSignal) => typeof builder;
    then: (resolve: (v: typeof result) => void) => void;
  } = {
    abortSignal: () => builder,
    then: (resolve) => resolve(result),
  };
  return builder;
}

vi.mock("@/integrations/supabase/client.server", () => ({
  supabaseAdmin: {
    from,
    rpc: (name: string) =>
      name === "reserve_http_request_slot"
        ? chainableRpc({ data: new Date().toISOString(), error: null })
        : chainableRpc({ data: "worker-1", error: null }),
  },
}));

const { refreshCandidateResearchSafely, RESEARCH_DEADLINE_MS } = await import("../shadow.server");
const { researchCadenceMs, RESEARCH_ZERO_PROGRESS_RETRY_MS, RESEARCH_REFRESH_HOURS } = await import(
  "./research.server"
);

const fetchCalls: string[] = [];
let aborts = 0;

function mockHangingFetch(hangOn?: string): void {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: { signal?: AbortSignal }) => {
      fetchCalls.push(String(url));
      if (!hangOn || String(url).includes(hangOn)) {
        return await new Promise((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => {
            aborts += 1;
            const err = new Error("aborted");
            err.name = "AbortError";
            reject(err);
          });
        });
      }
      const body = String(url).includes("/trades?")
        ? [
            {
              asset: "0xasset",
              size: 10,
              price: 0.4,
              timestamp: 1_760_000_000,
              title: "Market",
              slug: "market",
              outcome: "Yes",
              side: "BUY",
            },
          ]
        : String(url).includes("public-search")
          ? { profiles: [] }
          : [];
      return new Response(JSON.stringify(body), { status: 200 });
    }),
  );
}

const workerWrites = () => writes.filter((w) => w.table === "worker_status");

const candidate = (id: string): Row => ({
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

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-08-16T21:00:00.000Z"));
  writes.length = 0;
  fetchCalls.length = 0;
  aborts = 0;
  watchlist = [candidate("aaa")];
  runState = null;
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("scheduler deadline cancels candidate research", () => {
  it("aborts a hung public fetch and only returns once worker_status is terminal", async () => {
    mockHangingFetch();

    const pending = refreshCandidateResearchSafely();
    let settled = false;
    void pending.then(() => {
      settled = true;
    });

    await vi.advanceTimersByTimeAsync(RESEARCH_DEADLINE_MS - 1);
    expect(settled).toBe(false);
    expect(fetchCalls.length).toBeGreaterThan(0);

    await vi.advanceTimersByTimeAsync(2);
    const out = await pending;

    expect(aborts).toBeGreaterThan(0);
    const last = workerWrites().at(-1);
    expect(last).toBeDefined();
    expect(last!.payload["state"]).not.toBe("running");
    expect(String(out.detail)).toMatch(/budget exhausted/i);
  });

  it("leaves no background research work running after the helper returns", async () => {
    mockHangingFetch();

    const pending = refreshCandidateResearchSafely();
    await vi.advanceTimersByTimeAsync(RESEARCH_DEADLINE_MS + 1);
    await pending;

    const callsAtReturn = fetchCalls.length;
    const writesAtReturn = writes.length;
    await vi.advanceTimersByTimeAsync(60_000);
    expect(fetchCalls.length).toBe(callsAtReturn);
    expect(writes.length).toBe(writesAtReturn);
  });

  it("propagates the scheduler abort into the slippage/price-history fetch", async () => {
    mockHangingFetch("prices-history");

    const pending = refreshCandidateResearchSafely();
    // Flush the pass's own async steps (lease, bounded reads, trade/position
    // fetches) WITHOUT burning wall clock, so it is genuinely sitting on the
    // slippage fetch when the scheduler budget fires.
    for (let i = 0; i < 40; i += 1) await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(RESEARCH_DEADLINE_MS + 1);
    await pending;

    expect(fetchCalls.some((u) => u.includes("prices-history"))).toBe(true);
    expect(aborts).toBeGreaterThan(0);
    expect(workerWrites().at(-1)!.payload["state"]).not.toBe("running");
  });
});

describe("cadence after a bounded pass", () => {
  it("retries a zero-progress budget exhaustion on the short bounded cadence", () => {
    expect(researchCadenceMs({ state: "error", researchedCount: 0 })).toBe(RESEARCH_ZERO_PROGRESS_RETRY_MS);
    expect(RESEARCH_ZERO_PROGRESS_RETRY_MS).toBeGreaterThanOrEqual(10 * 60_000);
  });

  it("keeps the normal 6-hour cadence after a pass that made progress", () => {
    const sixHours = RESEARCH_REFRESH_HOURS * 3600_000;
    expect(researchCadenceMs({ state: "success", researchedCount: 3 })).toBe(sixHours);
    expect(researchCadenceMs({ state: "partial", researchedCount: 1 })).toBe(sixHours);
    expect(researchCadenceMs({ state: "error", researchedCount: 2 })).toBe(sixHours);
  });
});
