import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Regression: the SETTLEMENT-action paper_trades lifecycle row (Finding J)
 * must never be treated as an eligible trading decision by the comparison
 * read model, and the real settlement result (from paper_settlements) must
 * still enter performance exactly once — not doubled, not dropped.
 */

type Row = Record<string, unknown>;

const POSTGREST_ROW_CAP = 1000;

function makeFakeDb() {
  const tables: Record<string, Row[]> = {
    paper_experiments: [],
    paper_positions: [],
    paper_trades: [],
    paper_settlements: [],
    pipeline_audit: [],
    worker_status: [],
    worker_checkpoints: [],
    source_events: [],
    copyability_observations: [],
  };

  type Filter = { type: "eq" | "neq" | "gte" | "gt"; col: string; val: unknown };

  function matches(row: Row, filters: Filter[]): boolean {
    for (const f of filters) {
      if (f.type === "eq" && row[f.col] !== f.val) return false;
      if (f.type === "neq" && row[f.col] === f.val) return false;
      if (f.type === "gte" && !((row[f.col] as number) >= (f.val as number))) return false;
      if (f.type === "gt" && !((row[f.col] as number) > (f.val as number))) return false;
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
      if (rangeFromTo) {
        rows = rows.slice(rangeFromTo[0], Math.min(rangeFromTo[1] + 1, rangeFromTo[0] + POSTGREST_ROW_CAP));
      } else if (limitN !== null) {
        rows = rows.slice(0, Math.min(limitN, POSTGREST_ROW_CAP));
      } else {
        rows = rows.slice(0, POSTGREST_ROW_CAP);
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
      neq(col: string, val: unknown) {
        filters.push({ type: "neq", col, val });
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

  /** Mirrors the paper_trade_decision_stats SQL aggregate over the fake rows. */
  async function rpc(name: string, args: Record<string, unknown>) {
    if (name !== "paper_trade_decision_stats") throw new Error(`unexpected rpc ${name}`);
    const decisions = tables["paper_trades"]!.filter(
      (r) => r["experiment_id"] === args["p_experiment_id"] && r["action"] !== "SETTLEMENT",
    );
    const of = (action: string) => decisions.filter((r) => r["action"] === action);
    const avg = (action: string) => {
      const values = of(action)
        .map((r) => Number(r["notional"] ?? 0))
        .filter((n) => Number.isFinite(n) && n > 0);
      return values.length === 0 ? null : values.reduce((s, n) => s + n, 0) / values.length;
    };
    const counts = new Map<string, number>();
    for (const row of of("SKIP")) {
      const key = String(row["reason"] ?? "Unspecified").split("(")[0]!.trim() || "Unspecified";
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
    const sourceTs = decisions
      .map((r) => (r["source_ts"] === null || r["source_ts"] === undefined ? null : Number(r["source_ts"])))
      .filter((n): n is number => n !== null);
    return {
      data: {
        eligible_decisions: decisions.length,
        buys: of("BUY").length,
        sells: of("SELL").length,
        skips: of("SKIP").length,
        avg_buy_usd: avg("BUY"),
        avg_sell_usd: avg("SELL"),
        last_source_ts: sourceTs.length === 0 ? null : Math.max(...sourceTs),
        skip_reasons: [...counts]
          .map(([reason, count]) => ({ reason, count }))
          .sort((a, b) => b.count - a.count || a.reason.localeCompare(b.reason))
          .slice(0, 3),
      },
      error: null,
    };
  }

  return {
    tables,
    supabaseAdmin: { from: (table: string) => makeBuilder(table), rpc },
  };
}

const fake = makeFakeDb();

vi.mock("@/integrations/supabase/client.server", () => ({
  get supabaseAdmin() {
    return fake.supabaseAdmin;
  },
}));

const { loadComparison } = await import("./comparison.server");

const EXPERIMENT_ID = "exp-cmp-1";

beforeEach(() => {
  for (const key of Object.keys(fake.tables)) fake.tables[key]!.length = 0;
  fake.tables["paper_experiments"]!.push({
    id: EXPERIMENT_ID,
    name: "SHADOW V2: walletone",
    wallet_address: "0xabc",
    starting_cash: 100,
    cash: 112,
    realized_pnl: 12,
    enabled: true,
    follow_from_ts: 1_700_000_000,
    sizing_rule: "dynamic-v1",
  });
});

describe("comparison: settlement lifecycle row exclusion", () => {
  it("excludes the SETTLEMENT audit row from eligibleDecisions/skipRatePct while counting BUY/SELL/SKIP normally", async () => {
    fake.tables["paper_trades"]!.push(
      { id: "t1", experiment_id: EXPERIMENT_ID, action: "BUY", reason: null, realized_pnl: 0, created_at: "2026-08-01T00:00:00Z", notional: 5, source_ts: 100 },
      { id: "t2", experiment_id: EXPERIMENT_ID, action: "SELL", reason: null, realized_pnl: 3, created_at: "2026-08-02T00:00:00Z", notional: 5, source_ts: 101 },
      { id: "t3", experiment_id: EXPERIMENT_ID, action: "SKIP", reason: "Invalid source price", realized_pnl: 0, created_at: "2026-08-03T00:00:00Z", notional: 0, source_ts: 102 },
      {
        id: "t4",
        experiment_id: EXPERIMENT_ID,
        action: "SETTLEMENT",
        reason: "Settlement lifecycle evidence: WON (payout $9.00)",
        realized_pnl: 0,
        created_at: "2026-08-04T00:00:00Z",
        notional: 9,
        source_ts: null,
      },
    );
    fake.tables["paper_settlements"]!.push({
      id: "s1",
      experiment_id: EXPERIMENT_ID,
      realized_pnl: 9,
      settled_at: "2026-08-04T00:00:00Z",
    });

    const result = await loadComparison();
    const row = result.v2Rows.find((r) => r.id === EXPERIMENT_ID)!;

    // Only BUY/SELL/SKIP are eligible decisions — the SETTLEMENT row is excluded.
    expect(row.eligibleDecisions).toBe(3);
    expect(row.buys).toBe(1);
    expect(row.sells).toBe(1);
    expect(row.skippedCount).toBe(1);
    expect(row.skipRatePct).toBe(33.3);

    // Realized P&L: the SELL's $3 plus the settlement's $9 (from
    // paper_settlements) — never doubled by the zero-value audit row.
    expect(row.realizedPnl).toBe(12);
    expect(row.wins).toBe(2); // the $3 SELL and the $9 settlement
    expect(row.losses).toBe(0);
  });

  it("a settlement with no matching paper_settlements row still excludes the audit row from decisions", async () => {
    fake.tables["paper_trades"]!.push({
      id: "t1",
      experiment_id: EXPERIMENT_ID,
      action: "SETTLEMENT",
      reason: "Settlement lifecycle evidence: LOST (payout $0.00)",
      realized_pnl: 0,
      created_at: "2026-08-01T00:00:00Z",
      notional: 0,
      source_ts: null,
    });
    const result = await loadComparison();
    const row = result.v2Rows.find((r) => r.id === EXPERIMENT_ID)!;
    expect(row.eligibleDecisions).toBe(0);
    expect(row.buys).toBe(0);
    expect(row.sells).toBe(0);
    expect(row.skippedCount).toBe(0);
  });
});
