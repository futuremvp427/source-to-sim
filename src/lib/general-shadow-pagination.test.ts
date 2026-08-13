import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Regression: General Shadow's reporting reads (paper trades, settlements,
 * non-trade activity, copyability observations, post-go-live category
 * totals) previously used a single .limit(3000-5000) request, which
 * PostgREST silently truncates at its own row cap well below those limits.
 * These reads now page through fetchAllRows, so a backlog larger than the
 * old fixed window is still fully counted. fetchAllRows' own paging
 * mechanics are covered by db-pagination.test.ts; this file proves THIS
 * integration is wired correctly (ordering + id tiebreak against a fake
 * PostgREST that enforces the same ~1000-row-per-request cap).
 */

type Row = Record<string, unknown>;

const POSTGREST_ROW_CAP = 1000;

function makeFakeDb() {
  const tables: Record<string, Row[]> = {
    paper_experiments: [],
    source_events: [],
    paper_positions: [],
    paper_trades: [],
    paper_settlements: [],
    general_activity: [],
    copyability_observations: [],
    pipeline_audit: [],
    worker_status: [],
  };

  type Filter = { type: "eq" | "gte" | "gt" | "like"; col: string; val: unknown };

  function matches(row: Row, filters: Filter[]): boolean {
    for (const f of filters) {
      if (f.type === "eq" && row[f.col] !== f.val) return false;
      if (f.type === "gte" && !((row[f.col] as number) >= (f.val as number))) return false;
      if (f.type === "gt" && !((row[f.col] as number) > (f.val as number))) return false;
      if (f.type === "like") {
        const pattern = f.val as string;
        const prefix = pattern.endsWith("%") ? pattern.slice(0, -1) : pattern;
        if (!(row[f.col] as string).startsWith(prefix)) return false;
      }
    }
    return true;
  }

  function makeBuilder(table: string) {
    const filters: Filter[] = [];
    const orderBys: Array<{ col: string; ascending: boolean }> = [];
    let rangeFromTo: [number, number] | null = null;
    let limitN: number | null = null;
    let wantCount = false;
    let wantHead = false;

    async function execute(): Promise<{ data: Row[] | null; error: null; count: number | null }> {
      let rows = tables[table]!.filter((r) => matches(r, filters));
      const count = rows.length;
      if (wantHead) return { data: null, error: null, count: wantCount ? count : null };
      for (const ob of [...orderBys].reverse()) {
        rows = [...rows].sort((a, b) => {
          const av = a[ob.col] as string | number;
          const bv = b[ob.col] as string | number;
          if (av === bv) return 0;
          return (av < bv ? -1 : 1) * (ob.ascending ? 1 : -1);
        });
      }
      // Fake PostgREST: even a plain .limit() beyond the row cap is truncated,
      // exactly like the real API — this is the behavior the bug relied on.
      if (rangeFromTo) {
        rows = rows.slice(rangeFromTo[0], Math.min(rangeFromTo[1] + 1, rangeFromTo[0] + POSTGREST_ROW_CAP));
      } else {
        const cap = limitN === null ? POSTGREST_ROW_CAP : Math.min(limitN, POSTGREST_ROW_CAP);
        rows = rows.slice(0, cap);
      }
      return { data: rows, error: null, count: wantCount ? count : null };
    }

    const builder = {
      select(_cols: string, opts?: { count?: "exact"; head?: boolean }) {
        if (opts?.count === "exact") wantCount = true;
        if (opts?.head) wantHead = true;
        return builder;
      },
      eq(col: string, val: unknown) {
        filters.push({ type: "eq", col, val });
        return builder;
      },
      gte(col: string, val: unknown) {
        filters.push({ type: "gte", col, val });
        return builder;
      },
      gt(col: string, val: unknown) {
        filters.push({ type: "gt", col, val });
        return builder;
      },
      like(col: string, val: string) {
        filters.push({ type: "like", col, val });
        return builder;
      },
      order(col: string, opts: { ascending: boolean }) {
        orderBys.push({ col, ascending: opts.ascending });
        return builder;
      },
      range(from: number, to: number) {
        rangeFromTo = [from, to];
        return builder;
      },
      limit(n: number) {
        limitN = n;
        return builder;
      },
      async maybeSingle() {
        const res = await execute();
        return { data: res.data?.[0] ?? null, error: res.error };
      },
      then(resolve: (v: unknown) => unknown, reject?: (e: unknown) => unknown) {
        return execute().then(resolve, reject);
      },
    };
    return builder;
  }

  return {
    tables,
    supabaseAdmin: { from: (table: string) => makeBuilder(table) },
  };
}

const fake = makeFakeDb();

vi.mock("@/integrations/supabase/client.server", () => ({
  get supabaseAdmin() {
    return fake.supabaseAdmin;
  },
}));

const { loadGeneralShadow } = await import("./general-shadow.server");

const EXPERIMENT_ID = "exp-gs-1";
const WALLET = "0xgswallet";
const GO_LIVE_TS = 1_700_000_000;

beforeEach(() => {
  for (const key of Object.keys(fake.tables)) fake.tables[key]!.length = 0;
  fake.tables["paper_experiments"]!.push({
    id: EXPERIMENT_ID,
    name: "GENERAL SHADOW: walletone",
    wallet_address: WALLET,
    starting_cash: 380,
    cash: 380,
    realized_pnl: 0,
    follow_from_ts: GO_LIVE_TS,
  });
});

describe("General Shadow reporting pagination", () => {
  it("counts every paper trade beyond the old fixed window, with no duplicate/skip at the page boundary", async () => {
    const total = 1350; // > old 5000-row limit's real ceiling (1000) and > one fetchAllRows page
    for (let i = 0; i < total; i += 1) {
      // Cluster identical created_at timestamps straddling the 1000-row page
      // boundary (indices 995-1004): only the id tiebreak keeps this lossless.
      const clustered = i >= 995 && i <= 1004;
      const createdAt = clustered
        ? "2026-08-13T12:00:00.000Z"
        : new Date(1_700_000_000_000 + i * 1000).toISOString();
      fake.tables["paper_trades"]!.push({
        id: `t${String(i).padStart(5, "0")}`,
        experiment_id: EXPERIMENT_ID,
        action: i % 3 === 0 ? "SELL" : i % 3 === 1 ? "BUY" : "SKIP",
        reason: "test",
        realized_pnl: 0,
        created_at: createdAt,
      });
    }
    const result = await loadGeneralShadow();
    const wallet = result.wallets[0]!;
    const expectedBuys = Array.from({ length: total }, (_, i) => i).filter((i) => i % 3 === 1).length;
    const expectedSells = Array.from({ length: total }, (_, i) => i).filter((i) => i % 3 === 0).length;
    const expectedSkips = total - expectedBuys - expectedSells;
    expect(wallet.paper.buys).toBe(expectedBuys);
    expect(wallet.paper.sells).toBe(expectedSells);
    expect(wallet.paper.skips).toBe(expectedSkips);
    expect(wallet.paper.buys + wallet.paper.sells + wallet.paper.skips).toBe(total);
  });

  it("counts every settlement and every non-trade activity row beyond the old fixed window", async () => {
    const total = 1100;
    for (let i = 0; i < total; i += 1) {
      fake.tables["paper_settlements"]!.push({
        id: `s${String(i).padStart(5, "0")}`,
        experiment_id: EXPERIMENT_ID,
        realized_pnl: 1,
        settled_at: new Date(1_700_000_000_000 + i * 1000).toISOString(),
      });
      fake.tables["general_activity"]!.push({
        id: `a${String(i).padStart(5, "0")}`,
        wallet: WALLET,
        activity_type: "SPLIT",
      });
    }
    const result = await loadGeneralShadow();
    const wallet = result.wallets[0]!;
    expect(wallet.settlements).toBe(total);
    expect(wallet.activity.byType["SPLIT"]).toBe(total);
  });

  it("counts every post-go-live event into category totals beyond the old fixed window", async () => {
    const total = 1050;
    for (let i = 0; i < total; i += 1) {
      fake.tables["source_events"]!.push({
        id: `e${String(i).padStart(5, "0")}`,
        wallet: WALLET,
        source_ts: GO_LIVE_TS + i,
        market_title: "Some Market",
        slug: "some-market",
      });
    }
    const result = await loadGeneralShadow();
    const wallet = result.wallets[0]!;
    const totalCategoryEvents = wallet.categories.reduce((sum, c) => sum + c.events, 0);
    expect(totalCategoryEvents).toBe(total);
  });
});
