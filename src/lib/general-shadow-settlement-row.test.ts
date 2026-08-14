import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Regression: General Shadow's buy/sell/skip loop previously treated any
 * paper_trades action other than BUY/SELL as a SKIP. The new SETTLEMENT
 * lifecycle audit row (Finding J) is neither — it must not inflate the
 * skip count or skip-reason breakdown.
 */

type Row = Record<string, unknown>;

function makeFakeDb() {
  const tables: Record<string, Row[]> = {
    paper_experiments: [],
    paper_trades: [],
    paper_positions: [],
    paper_settlements: [],
    general_activity: [],
    copyability_observations: [],
    pipeline_audit: [],
    worker_status: [],
    source_events: [],
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
      if (rangeFromTo) rows = rows.slice(rangeFromTo[0], rangeFromTo[1] + 1);
      else if (limitN !== null) rows = rows.slice(0, limitN);
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

  return { tables, supabaseAdmin: { from: (table: string) => makeBuilder(table) } };
}

const fake = makeFakeDb();

vi.mock("@/integrations/supabase/client.server", () => ({
  get supabaseAdmin() {
    return fake.supabaseAdmin;
  },
}));

const { loadGeneralShadow } = await import("./general-shadow.server");

const EXPERIMENT_ID = "exp-gs-settle-1";
const WALLET = "0xgssettle";
const GO_LIVE_TS = 1_700_000_000;

beforeEach(() => {
  for (const key of Object.keys(fake.tables)) fake.tables[key]!.length = 0;
  fake.tables["paper_experiments"]!.push({
    id: EXPERIMENT_ID,
    name: "GENERAL SHADOW: settlewallet",
    wallet_address: WALLET,
    starting_cash: 380,
    cash: 380,
    realized_pnl: 0,
    follow_from_ts: GO_LIVE_TS,
  });
});

describe("General Shadow: SETTLEMENT audit row is not a skip", () => {
  it("does not count a SETTLEMENT-action row as a skip or a skip reason", async () => {
    fake.tables["paper_trades"]!.push(
      { id: "t1", experiment_id: EXPERIMENT_ID, action: "BUY", reason: null, realized_pnl: 0, created_at: "2026-08-01T00:00:00Z" },
      { id: "t2", experiment_id: EXPERIMENT_ID, action: "SKIP", reason: "Invalid source price", realized_pnl: 0, created_at: "2026-08-02T00:00:00Z" },
      {
        id: "t3",
        experiment_id: EXPERIMENT_ID,
        action: "SETTLEMENT",
        reason: "Settlement lifecycle evidence: WON (payout $9.00)",
        realized_pnl: 0,
        created_at: "2026-08-03T00:00:00Z",
      },
    );
    const result = await loadGeneralShadow();
    const wallet = result.wallets[0]!;
    expect(wallet.paper.buys).toBe(1);
    expect(wallet.paper.sells).toBe(0);
    expect(wallet.paper.skips).toBe(1);
    expect(wallet.paper.skipReasons.map((r) => r.reason)).not.toContain("Settlement lifecycle evidence: WON ");
  });
});
