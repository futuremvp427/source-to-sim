import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Deterministic regressions for the copyability scheduling cursor and the
 * CAS pending-observation transition, against a minimal in-memory fake of
 * the exact supabase-js query shapes these two functions issue. The fake
 * re-evaluates filters against live mutable table state on every call, so a
 * status='pending' guard genuinely stops a second write the same way a real
 * Postgres row-level UPDATE ... WHERE would.
 */

type Row = Record<string, unknown>;

function parseOrFilter(filterStr: string): Array<Array<{ col: string; op: string; val: string }>> {
  const parts: string[] = [];
  let depth = 0;
  let cur = "";
  for (const ch of filterStr) {
    if (ch === "(") depth += 1;
    if (ch === ")") depth -= 1;
    if (ch === "," && depth === 0) {
      parts.push(cur);
      cur = "";
    } else {
      cur += ch;
    }
  }
  if (cur) parts.push(cur);
  return parts.map((part) => {
    const body = part.startsWith("and(") ? part.slice(4, -1) : part;
    return body.split(",").map((clause) => {
      const [col, op, val] = clause.split(".") as [string, string, string];
      return { col, op, val };
    });
  });
}

function makeFakeDb() {
  const tables: Record<string, Row[]> = {
    paper_experiments: [],
    paper_trades: [],
    copyability_observations: [],
  };
  let failNextUpsert: string | null = null;

  type Filter = { type: "eq" | "lte" | "in" | "or"; col: string; val: unknown };

  function matches(row: Row, filters: Filter[]): boolean {
    for (const f of filters) {
      if (f.type === "eq" && row[f.col] !== f.val) return false;
      if (f.type === "lte" && !((row[f.col] as string) <= (f.val as string))) return false;
      if (f.type === "in" && !(f.val as unknown[]).includes(row[f.col])) return false;
      if (f.type === "or") {
        const groups = f.val as Array<Array<{ col: string; op: string; val: string }>>;
        const ok = groups.some((group) =>
          group.every((cond) => {
            const rowVal = row[cond.col] as string;
            if (cond.op === "gt") return rowVal > cond.val;
            if (cond.op === "eq") return rowVal === cond.val;
            return false;
          }),
        );
        if (!ok) return false;
      }
    }
    return true;
  }

  function makeBuilder(table: string) {
    const filters: Filter[] = [];
    const orderBys: Array<{ col: string; ascending: boolean }> = [];
    let limitN: number | null = null;
    let mode: "select" | "update" | "upsert" = "select";
    let updatePatch: Row | null = null;
    let upsertRows: Row[] | null = null;
    let upsertOnConflict: string[] = [];
    let upsertIgnoreDuplicates = false;

    async function execute(): Promise<{ data: Row[] | null; error: { message: string } | null }> {
      if (mode === "update") {
        const rows = tables[table]!.filter((r) => matches(r, filters));
        for (const r of rows) Object.assign(r, updatePatch);
        return { data: rows.map((r) => ({ id: r["id"] })), error: null };
      }
      if (mode === "upsert") {
        if (failNextUpsert === table) {
          failNextUpsert = null;
          return { data: null, error: { message: "simulated upsert failure" } };
        }
        const inserted: Row[] = [];
        for (const row of upsertRows!) {
          const conflict = tables[table]!.find((r) => upsertOnConflict.every((c) => r[c] === row[c]));
          if (conflict) {
            if (!upsertIgnoreDuplicates) Object.assign(conflict, row);
            continue;
          }
          const withId: Row = { id: `id-${tables[table]!.length}-${inserted.length}`, ...row };
          tables[table]!.push(withId);
          inserted.push(withId);
        }
        return { data: inserted, error: null };
      }
      let rows = tables[table]!.filter((r) => matches(r, filters));
      for (const ob of [...orderBys].reverse()) {
        rows = [...rows].sort((a, b) => {
          const av = a[ob.col] as string;
          const bv = b[ob.col] as string;
          if (av === bv) return 0;
          return (av < bv ? -1 : 1) * (ob.ascending ? 1 : -1);
        });
      }
      if (limitN !== null) rows = rows.slice(0, limitN);
      return { data: rows, error: null };
    }

    const builder = {
      select() {
        return builder;
      },
      eq(col: string, val: unknown) {
        filters.push({ type: "eq", col, val });
        return builder;
      },
      lte(col: string, val: unknown) {
        filters.push({ type: "lte", col, val });
        return builder;
      },
      in(col: string, val: unknown[]) {
        filters.push({ type: "in", col, val });
        return builder;
      },
      or(filterStr: string) {
        filters.push({ type: "or", col: "", val: parseOrFilter(filterStr) });
        return builder;
      },
      order(col: string, opts: { ascending: boolean }) {
        orderBys.push({ col, ascending: opts.ascending });
        return builder;
      },
      limit(n: number) {
        limitN = n;
        return builder;
      },
      update(patch: Row) {
        mode = "update";
        updatePatch = patch;
        return builder;
      },
      upsert(rows: Row[], opts: { onConflict: string; ignoreDuplicates: boolean }) {
        mode = "upsert";
        upsertRows = rows;
        upsertOnConflict = opts.onConflict.split(",");
        upsertIgnoreDuplicates = opts.ignoreDuplicates;
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
    failNextUpsert(table: string) {
      failNextUpsert = table;
    },
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

const { scheduleObservations, claimObservationTransition } = await import("./observe.server");

const EXPERIMENT = { id: "exp-1", starting_cash: 380, cash: 380 };

function seedTrade(id: string, createdAt: string, overrides: Partial<Row> = {}): void {
  fake.tables["paper_trades"]!.push({
    id,
    experiment_id: EXPERIMENT.id,
    event_key: `evt-${id}`,
    source_event_id: null,
    asset: "asset-1",
    market_title: "Market",
    side: "BUY",
    price: 0.5,
    shares: 10,
    source_ts: 1000,
    created_at: createdAt,
    ...overrides,
  });
}

beforeEach(() => {
  fake.tables["paper_experiments"]!.length = 0;
  fake.tables["paper_trades"]!.length = 0;
  fake.tables["copyability_observations"]!.length = 0;
  fake.tables["paper_experiments"]!.push({ id: EXPERIMENT.id });
});

describe("scheduleObservations cursor", () => {
  it("a successful page advances the persisted cursor", async () => {
    seedTrade("t1", "2026-08-13T00:00:00.000Z");
    seedTrade("t2", "2026-08-13T00:00:01.000Z");
    await scheduleObservations(EXPERIMENT);
    const exp = fake.tables["paper_experiments"]!.find((r) => r["id"] === EXPERIMENT.id)!;
    expect(exp["copyability_cursor_created_at"]).toBe("2026-08-13T00:00:01.000Z");
    expect(exp["copyability_cursor_id"]).toBe("t2");
  });

  it("failed scheduling persistence does not advance the cursor", async () => {
    seedTrade("t1", "2026-08-13T00:00:00.000Z");
    fake.failNextUpsert("copyability_observations");
    await expect(scheduleObservations(EXPERIMENT)).rejects.toThrow("simulated upsert failure");
    const exp = fake.tables["paper_experiments"]!.find((r) => r["id"] === EXPERIMENT.id)!;
    expect(exp["copyability_cursor_created_at"]).toBeUndefined();
    expect(exp["copyability_cursor_id"]).toBeUndefined();
  });

  it("a backlog larger than the batch size is fully scheduled across repeated cycles", async () => {
    for (let i = 0; i < 25; i += 1) {
      seedTrade(`t${i}`, `2026-08-13T00:00:${String(i).padStart(2, "0")}.000Z`);
    }
    let totalInserted = 0;
    for (let cycle = 0; cycle < 10; cycle += 1) {
      totalInserted += await scheduleObservations(EXPERIMENT);
    }
    const scheduledEventKeys = new Set(
      fake.tables["copyability_observations"]!.map((r) => r["event_key"] as string),
    );
    expect(scheduledEventKeys.size).toBe(25);
    const exp = fake.tables["paper_experiments"]!.find((r) => r["id"] === EXPERIMENT.id)!;
    expect(exp["copyability_cursor_id"]).toBe("t24");
  });

  it("rescanning after the cursor has caught up schedules nothing new (idempotent)", async () => {
    seedTrade("t1", "2026-08-13T00:00:00.000Z");
    await scheduleObservations(EXPERIMENT);
    const before = fake.tables["copyability_observations"]!.length;
    const insertedOnRescan = await scheduleObservations(EXPERIMENT);
    expect(insertedOnRescan).toBe(0);
    expect(fake.tables["copyability_observations"]!.length).toBe(before);
  });

  it("resumes deterministically from a persisted cursor, never re-scheduling already-covered trades", async () => {
    seedTrade("t1", "2026-08-13T00:00:00.000Z");
    await scheduleObservations(EXPERIMENT);
    seedTrade("t2", "2026-08-13T00:00:01.000Z");
    await scheduleObservations(EXPERIMENT);
    const t1Rows = fake.tables["copyability_observations"]!.filter((r) => r["event_key"] === "evt-t1");
    // Still exactly one row per sample_delay for t1 — the second cycle never rescanned it.
    expect(t1Rows.length).toBeGreaterThan(0);
    const t2Rows = fake.tables["copyability_observations"]!.filter((r) => r["event_key"] === "evt-t2");
    expect(t2Rows.length).toBe(t1Rows.length);
  });
});

describe("claimObservationTransition (CAS)", () => {
  beforeEach(() => {
    fake.tables["copyability_observations"]!.push({
      id: "obs-1",
      status: "pending",
      observed_at: null,
      slippage_cents: null,
    });
  });

  it("a single pending claim wins and applies its patch", async () => {
    const won = await claimObservationTransition("obs-1", { status: "observed", slippage_cents: 12 });
    expect(won).toBe(true);
    const row = fake.tables["copyability_observations"]!.find((r) => r["id"] === "obs-1")!;
    expect(row["status"]).toBe("observed");
    expect(row["slippage_cents"]).toBe(12);
  });

  it("two racing workers on the same pending row: only one transition wins", async () => {
    const first = await claimObservationTransition("obs-1", { status: "observed", slippage_cents: 12 });
    const second = await claimObservationTransition("obs-1", { status: "unavailable", slippage_cents: null });
    expect(first).toBe(true);
    expect(second).toBe(false);
  });

  it("the loser cannot overwrite the winner's observed_at/slippage/status", async () => {
    await claimObservationTransition("obs-1", {
      status: "observed",
      observed_at: "2026-08-13T00:00:05.000Z",
      slippage_cents: 12,
    });
    await claimObservationTransition("obs-1", {
      status: "unavailable",
      observed_at: "2026-08-13T00:00:06.000Z",
      slippage_cents: null,
    });
    const row = fake.tables["copyability_observations"]!.find((r) => r["id"] === "obs-1")!;
    expect(row["status"]).toBe("observed");
    expect(row["observed_at"]).toBe("2026-08-13T00:00:05.000Z");
    expect(row["slippage_cents"]).toBe(12);
  });

  it("a claim against an already-observed/unavailable row never re-transitions it", async () => {
    fake.tables["copyability_observations"]!.push({ id: "obs-2", status: "unavailable", observed_at: "x" });
    const claimed = await claimObservationTransition("obs-2", { status: "observed", slippage_cents: 99 });
    expect(claimed).toBe(false);
    const row = fake.tables["copyability_observations"]!.find((r) => r["id"] === "obs-2")!;
    expect(row["status"]).toBe("unavailable");
  });
});
