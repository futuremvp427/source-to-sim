import { describe, expect, it, vi } from "vitest";

/**
 * Regression for the documented reconciliation race: source_position_state is
 * WALLET-scoped, but V2 and V3 sibling experiments follow the same wallet and
 * each call reconcile() within ~1s of each other every cron tick. Unfenced,
 * their full-history replays raced on the same cache rows, producing an
 * oscillating repair count (production: 55 -> 111 -> 2 -> 20 -> 5 in 13
 * minutes) and doubling replay load during the statement-timeout wave.
 */

type Write = { table: string; rows: unknown };

let leaseHeldBy: string | null = null;
const writes: Write[] = [];
const alerts: { level: string; kind: string }[] = [];
const sourceEvents = [
  { asset: "asset-a", side: "BUY", shares: 10 },
  { asset: "asset-a", side: "SELL", shares: 4 },
  { asset: "asset-b", side: "BUY", shares: 7 },
];
/** Deliberately stale compact cache, i.e. a real divergence to repair. */
const compact = [{ asset: "asset-a", shares: 99 }];

function rowsThenable(table: string, rows: unknown[]) {
  const chain = {
    select: () => chain,
    eq: () => chain,
    order: () => chain,
    range: (from: number) => (from === 0 ? chain : emptyChain(table)),
    upsert: (r: unknown) => {
      writes.push({ table, rows: r });
      return { then: (res: (v: unknown) => void) => res({ data: null, error: null }) };
    },
    then: (resolve: (v: { data: unknown; error: unknown }) => void) =>
      resolve({ data: rows, error: null }),
  };
  return chain;
}
function emptyChain(table: string) {
  return rowsThenable(table, []);
}

vi.mock("@/integrations/supabase/client.server", () => ({
  supabaseAdmin: {
    rpc: (name: string, args: Record<string, string>) => ({
      then: (resolve: (v: { data: unknown; error: unknown }) => void) => {
        if (name === "try_acquire_reconcile_lease") {
          if (leaseHeldBy === null) {
            leaseHeldBy = args["p_holder"] as string;
            resolve({ data: true, error: null });
          } else {
            resolve({ data: false, error: null });
          }
          return;
        }
        if (name === "release_reconcile_lease") {
          if (leaseHeldBy === args["p_holder"]) leaseHeldBy = null;
          resolve({ data: null, error: null });
          return;
        }
        resolve({ data: null, error: null });
      },
    }),
    from: (table: string) => {
      if (table === "source_events") return rowsThenable(table, sourceEvents);
      if (table === "source_position_state") return rowsThenable(table, compact);
      if (table === "alerts") {
        const chain = {
          upsert: () => chain,
          insert: () => chain,
          select: () => chain,
          then: (resolve: (v: { data: unknown; error: unknown }) => void) =>
            resolve({ data: [], error: null }),
        };
        return chain;
      }
      return rowsThenable(table, []);
    },
  },
}));

vi.mock("./notify.server", () => ({ notifyAlert: async () => undefined }));

const shadow = await import("./shadow.server");
const originalRaise = shadow.raiseAlert;
void originalRaise;

const WALLET = "0x044f334595a7fd42c143e11c8ec47f23c8d1d1f1";

describe("wallet-scoped reconciliation serialization", () => {
  it("lets only one sibling reconcile a wallet at a time", async () => {
    leaseHeldBy = null;
    writes.length = 0;
    alerts.length = 0;

    // Hold the lease as if the sibling V3 experiment already started.
    leaseHeldBy = "reconcile:sibling";
    const loser = await shadow.reconcile(WALLET);

    expect(loser.skipped).toBe(true);
    expect(loser.mismatches).toBe(0);
    // The loser performed NO write at all: no overwrite is possible.
    expect(writes).toHaveLength(0);
  });

  it("the winner repairs compact state from the persisted event replay only", async () => {
    leaseHeldBy = null;
    writes.length = 0;

    const winner = await shadow.reconcile(WALLET);

    expect(winner.replayComplete).toBe(true);
    expect(winner.skipped).toBeUndefined();
    // Only the wallet-level compact cache is ever written.
    expect(new Set(writes.map((w) => w.table))).toEqual(new Set(["source_position_state"]));
    const rows = writes.flatMap((w) => w.rows as { asset: string; shares: number }[]);
    // Result matches the replay: 10 - 4 = 6 and 7, not the stale 99.
    expect(rows.find((r) => r.asset === "asset-a")?.shares).toBe(6);
    expect(rows.find((r) => r.asset === "asset-b")?.shares).toBe(7);
  });

  it("releases the lease so the next cycle can reconcile again", async () => {
    leaseHeldBy = null;
    writes.length = 0;
    await shadow.reconcile(WALLET);
    expect(leaseHeldBy).toBeNull();
    const second = await shadow.reconcile(WALLET);
    expect(second.skipped).toBeUndefined();
  });

  it("never touches paper accounting tables", async () => {
    leaseHeldBy = null;
    writes.length = 0;
    await shadow.reconcile(WALLET, { expectAdvance: true });
    for (const w of writes) {
      expect(["paper_trades", "paper_positions", "paper_experiments", "paper_settlements"]).not.toContain(
        w.table,
      );
    }
  });
});
