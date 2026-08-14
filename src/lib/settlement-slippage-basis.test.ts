import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Regression: settlement-time slippage basis provenance. loadSettlementSlippageBasis
 * must use the same prior-utc-day-v1 no-lookahead cutoff as the Phase 2 observation
 * panel — only observations strictly before 00:00:00 UTC on the settlement's own day
 * are eligible — and must never fabricate a value when no eligible sample exists.
 */

type Row = Record<string, unknown>;

function makeFakeDb() {
  const tables: Record<string, Row[]> = { copyability_observations: [] };

  type Filter =
    | { type: "eq"; col: string; val: unknown }
    | { type: "not_is_null"; col: string }
    | { type: "lt"; col: string; val: string };

  function matches(row: Row, filters: Filter[]): boolean {
    for (const f of filters) {
      if (f.type === "eq" && row[f.col] !== f.val) return false;
      if (f.type === "not_is_null" && row[f.col] === null) return false;
      if (f.type === "lt" && !((row[f.col] as string) < f.val)) return false;
    }
    return true;
  }

  function makeBuilder(table: string) {
    const filters: Filter[] = [];
    const orderBys: Array<{ col: string; ascending: boolean }> = [];
    let limitN: number | null = null;

    async function execute(): Promise<{ data: Row[]; error: null }> {
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
      not(col: string, _op: string, _val: null) {
        filters.push({ type: "not_is_null", col });
        return builder;
      },
      lt(col: string, val: string) {
        filters.push({ type: "lt", col, val });
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

const { loadSettlementSlippageBasis } = await import("./settlement.server");
const { SLIPPAGE_METHODOLOGY_VERSION } = await import("./observation/slippage-asof");

const EXPERIMENT_ID = "exp-basis-1";

function seed(id: string, observedAt: string, slippageCents: number | null, status = "observed"): void {
  fake.tables["copyability_observations"]!.push({
    id,
    experiment_id: EXPERIMENT_ID,
    status,
    slippage_cents: slippageCents,
    observed_at: observedAt,
  });
}

beforeEach(() => {
  fake.tables["copyability_observations"]!.length = 0;
});

describe("settlement slippage basis provenance", () => {
  it("stores basis metadata computed only from samples strictly before the settlement day's UTC cutoff", async () => {
    // Settlement resolves on 2026-08-13; cutoff is 2026-08-13T00:00:00.000Z.
    seed("o1", "2026-08-12T23:00:00.000Z", 10);
    seed("o2", "2026-08-12T22:00:00.000Z", 20);
    const basis = await loadSettlementSlippageBasis(EXPERIMENT_ID, "2026-08-13T12:00:00.000Z");
    expect(basis.cutoffAt).toBe("2026-08-13T00:00:00.000Z");
    expect(basis.medianCents).toBe(15);
    expect(basis.sampleCount).toBe(2);
    expect(basis.methodologyVersion).toBe(SLIPPAGE_METHODOLOGY_VERSION);
  });

  it("a later observation on/after the settlement day never changes the basis for that day (no lookahead)", async () => {
    seed("o1", "2026-08-12T23:00:00.000Z", 10);
    const before = await loadSettlementSlippageBasis(EXPERIMENT_ID, "2026-08-13T12:00:00.000Z");
    // A sample observed on the settlement day itself arrives afterwards.
    seed("o2", "2026-08-13T05:00:00.000Z", 999);
    const after = await loadSettlementSlippageBasis(EXPERIMENT_ID, "2026-08-13T12:00:00.000Z");
    expect(after.medianCents).toBe(before.medianCents);
    expect(after.sampleCount).toBe(before.sampleCount);
  });

  it("never fabricates a basis when no eligible sample exists (stays unavailable, not reconstructed)", async () => {
    const basis = await loadSettlementSlippageBasis(EXPERIMENT_ID, "2026-08-13T12:00:00.000Z");
    expect(basis.medianCents).toBeNull();
    expect(basis.sampleCount).toBe(0);
  });

  it("excludes non-observed status and null slippage_cents rows", async () => {
    seed("o1", "2026-08-12T23:00:00.000Z", 10, "unavailable");
    seed("o2", "2026-08-12T22:00:00.000Z", null);
    const basis = await loadSettlementSlippageBasis(EXPERIMENT_ID, "2026-08-13T12:00:00.000Z");
    expect(basis.sampleCount).toBe(0);
    expect(basis.medianCents).toBeNull();
  });
});
