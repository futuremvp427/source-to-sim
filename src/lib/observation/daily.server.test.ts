import { beforeEach, describe, expect, it, vi } from "vitest";

type Row = Record<string, unknown>;

function like(value: unknown, pattern: string): boolean {
  const text = String(value ?? "");
  if (pattern.endsWith("%")) return text.startsWith(pattern.slice(0, -1));
  return text === pattern;
}

function parseOr(filter: string): Array<{ col: string; op: string; val: string }> {
  return filter.split(",").map((part) => {
    const [col, op, ...rest] = part.split(".");
    return { col: col!, op: op!, val: rest.join(".") };
  });
}

function makeFakeDb() {
  const tables: Record<string, Row[]> = {
    paper_experiments: [],
    paper_settlements: [],
    copyability_observations: [],
    paper_positions: [],
    paper_trades: [],
    worker_status: [],
  };

  type Filter =
    | { type: "eq"; col: string; val: unknown }
    | { type: "not"; col: string; op: string; val: unknown }
    | { type: "lt"; col: string; val: unknown }
    | { type: "like"; col: string; val: string }
    | { type: "or"; clauses: Array<{ col: string; op: string; val: string }> };

  function matches(row: Row, filters: Filter[]): boolean {
    for (const f of filters) {
      if (f.type === "eq" && row[f.col] !== f.val) return false;
      if (f.type === "lt" && !((row[f.col] as string) < (f.val as string))) return false;
      if (f.type === "like" && !like(row[f.col], f.val)) return false;
      if (f.type === "not" && f.op === "is" && f.val === null && row[f.col] === null) return false;
      if (f.type === "or") {
        const ok = f.clauses.some((clause) => {
          if (clause.op === "like") return like(row[clause.col], clause.val);
          return false;
        });
        if (!ok) return false;
      }
    }
    return true;
  }

  function makeBuilder(table: string) {
    const filters: Filter[] = [];
    const orders: Array<{ col: string; ascending: boolean }> = [];
    let limitN: number | null = null;
    let rangeFrom: number | null = null;
    let rangeTo: number | null = null;
    let countRequested = false;
    let headRequested = false;

    async function execute(): Promise<{ data: Row[] | null; count: number | null; error: null }> {
      let rows = tables[table]!.filter((row) => matches(row, filters));
      const count = countRequested ? rows.length : null;
      for (const order of [...orders].reverse()) {
        rows = [...rows].sort((a, b) => {
          const av = a[order.col] as string;
          const bv = b[order.col] as string;
          if (av === bv) return 0;
          return (av < bv ? -1 : 1) * (order.ascending ? 1 : -1);
        });
      }
      if (rangeFrom !== null && rangeTo !== null) rows = rows.slice(rangeFrom, rangeTo + 1);
      if (limitN !== null) rows = rows.slice(0, limitN);
      return { data: headRequested ? null : rows, count, error: null };
    }

    const builder = {
      select(_columns?: string, options?: { count?: string; head?: boolean }) {
        countRequested = options?.count === "exact";
        headRequested = options?.head === true;
        return builder;
      },
      eq(col: string, val: unknown) {
        filters.push({ type: "eq", col, val });
        return builder;
      },
      not(col: string, op: string, val: unknown) {
        filters.push({ type: "not", col, op, val });
        return builder;
      },
      lt(col: string, val: unknown) {
        filters.push({ type: "lt", col, val });
        return builder;
      },
      like(col: string, val: string) {
        filters.push({ type: "like", col, val });
        return builder;
      },
      or(filter: string) {
        filters.push({ type: "or", clauses: parseOr(filter) });
        return builder;
      },
      order(col: string, options: { ascending: boolean }) {
        orders.push({ col, ascending: options.ascending });
        return builder;
      },
      range(from: number, to: number) {
        rangeFrom = from;
        rangeTo = to;
        return builder;
      },
      limit(n: number) {
        limitN = n;
        return builder;
      },
      async maybeSingle() {
        const result = await execute();
        return { data: result.data?.[0] ?? null, error: null };
      },
      then(resolve: (value: unknown) => unknown, reject?: (reason: unknown) => unknown) {
        return execute().then(resolve, reject);
      },
    };
    return builder;
  }

  return {
    tables,
    supabaseAdmin: {
      from: (table: string) => makeBuilder(table),
    },
  };
}

const fake = makeFakeDb();

vi.mock("@/integrations/supabase/client.server", () => ({
  get supabaseAdmin() {
    return fake.supabaseAdmin;
  },
}));

const { loadObservationLog } = await import("./daily.server");

function settlement(experimentId: string, realizedPnl: number): Row {
  return {
    id: `settlement-${experimentId}`,
    experiment_id: experimentId,
    resolution_ts: "2026-01-02T12:00:00.000Z",
    shares: 10,
    cost_basis: 5,
    payout: 10,
    realized_pnl: realizedPnl,
  };
}

function slippage(experimentId: string, id: string, observedAt: string, slippageCents: number): Row {
  return {
    id,
    experiment_id: experimentId,
    event_key: `event-${id}`,
    sample_delay: "immediate",
    status: "observed",
    slippage_cents: slippageCents,
    slippage_pct: slippageCents * 2,
    spread: 1,
    fillable: true,
    observed_at: observedAt,
  };
}

beforeEach(() => {
  for (const rows of Object.values(fake.tables)) rows.length = 0;
  fake.tables["paper_experiments"]!.push(
    { id: "pol-v2", name: "SHADOW V2: Poligarch", enabled: true },
    { id: "bad-v2", name: "SHADOW V2: badatmath.", enabled: true },
    { id: "pol-v3", name: "SHADOW V3 CAPACITY: Poligarch", enabled: true },
    { id: "disabled-v2", name: "SHADOW V2: gghff", enabled: false },
    { id: "legacy", name: "SHADOW:Poligarch", enabled: true },
  );
  fake.tables["paper_settlements"]!.push(settlement("pol-v2", 5), settlement("bad-v2", 5));
  fake.tables["copyability_observations"]!.push(
    slippage("pol-v2", "pol-before", "2026-01-01T12:00:00.000Z", 0),
    slippage("bad-v2", "bad-before", "2026-01-01T12:00:00.000Z", 10),
    slippage("bad-v2", "bad-same-day", "2026-01-02T12:00:00.000Z", 90),
  );
});

describe("loadObservationLog", () => {
  it("reports friction-adjusted metrics for non-Poligarch enabled V2/V3 experiments", async () => {
    const log = await loadObservationLog();
    expect(log.scope).toBe("ALL_ENABLED_V2_V3");
    expect(log.series.map((series) => series.name)).toEqual([
      "SHADOW V2: badatmath.",
      "SHADOW V2: Poligarch",
      "SHADOW V3 CAPACITY: Poligarch",
    ]);

    const nonPoligarch = log.series.find((series) => series.name === "SHADOW V2: badatmath.")!;
    expect(nonPoligarch.realizedPnl).toBe(5);
    expect(nonPoligarch.slippageAdjustedCumulativePnl).toBe(3.33);
  });

  it("keeps the legacy Poligarch-only cohort available", async () => {
    const log = await loadObservationLog({ scope: "POLIGARCH_ONLY" });
    expect(log.series.map((series) => series.name)).toEqual([
      "SHADOW V2: Poligarch",
      "SHADOW V3 CAPACITY: Poligarch",
    ]);
  });

  it("keeps raw paper P&L separate from friction-adjusted/copyable P&L", async () => {
    const log = await loadObservationLog();
    const row = log.series.find((series) => series.name === "SHADOW V2: badatmath.")!;
    expect(row.realizedPnl).toBe(5);
    expect(row.slippageAdjustedCumulativePnl).not.toBe(row.realizedPnl);
    expect(row.days[0]).toMatchObject({
      realizedPnl: 5,
      cumulativeRealizedPnl: 5,
      slippageAdjustedPnl: 3.33,
      cumulativeSlippageAdjustedPnl: 3.33,
    });
  });

  it("preserves the no-lookahead prior-UTC-day cutoff", async () => {
    const before = await loadObservationLog();
    const beforeAdjusted = before.series.find((series) => series.name === "SHADOW V2: badatmath.")!
      .slippageAdjustedCumulativePnl;

    fake.tables["copyability_observations"]!.push(
      slippage("bad-v2", "bad-late-worse", "2026-01-03T12:00:00.000Z", 200),
    );

    const after = await loadObservationLog();
    const afterAdjusted = after.series.find((series) => series.name === "SHADOW V2: badatmath.")!
      .slippageAdjustedCumulativePnl;
    expect(afterAdjusted).toBe(beforeAdjusted);
  });
});
