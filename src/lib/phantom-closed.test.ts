import { describe, expect, it } from "vitest";

import {
  EMPTY_POSITION,
  applyBuy,
  applySell,
  decideDynamicBuy,
  decideProportionalSell,
  isPhantomClosedPosition,
  shouldPersistPaperPosition,
  type PaperPositionState,
} from "./shadow-core";

type Event = { asset: string; side: "BUY" | "SELL"; price: number; shares: number };
type Row = {
  asset: string;
  shares: number;
  cost_basis: number;
  realized_pnl: number;
  settlement_status: string;
};

/** Mirrors processPendingEvents' batch loop + write-gate, without the database. */
function runBatch(input: {
  events: Event[];
  startingCash: number;
  cash: number;
  existing?: Map<string, PaperPositionState>;
  sourceShares?: Map<string, number>;
}) {
  const paper = new Map<string, PaperPositionState>(input.existing ?? []);
  const existingPaperAssets = new Set(paper.keys());
  const tradedAssets = new Set<string>();
  const sourceShares = new Map(input.sourceShares ?? []);
  let cash = input.cash;

  for (const e of input.events) {
    const position = paper.get(e.asset) ?? EMPTY_POSITION;
    const before = sourceShares.has(e.asset) ? (sourceShares.get(e.asset) as number) : null;
    const decision =
      e.side === "BUY"
        ? decideDynamicBuy({ price: e.price, startingCash: input.startingCash, cash })
        : decideProportionalSell({
            price: e.price,
            sourceSharesBefore: before,
            sourceSoldShares: e.shares,
            paperShares: position.shares,
          });
    let next = position;
    if (decision.action === "BUY") {
      const applied = applyBuy(position, cash, decision.shares, decision.notional);
      next = applied.position;
      cash = applied.cash;
      tradedAssets.add(e.asset);
    } else if (decision.action === "SELL") {
      const applied = applySell(position, cash, decision.shares, decision.price);
      next = applied.position;
      cash = applied.cash;
      tradedAssets.add(e.asset);
    }
    paper.set(e.asset, next);
    sourceShares.set(
      e.asset,
      e.side === "BUY" ? (before ?? 0) + e.shares : Math.max(0, (before ?? 0) - e.shares),
    );
  }

  const rows: Row[] = [...paper]
    .filter(([asset]) =>
      shouldPersistPaperPosition({
        hadExistingRow: existingPaperAssets.has(asset),
        tradedThisBatch: tradedAssets.has(asset),
      }),
    )
    .map(([asset, p]) => ({
      asset,
      shares: p.shares,
      cost_basis: p.costBasis,
      realized_pnl: p.realizedPnl,
      settlement_status: p.shares > 0 ? "open" : "closed",
    }));

  return { rows, cash };
}

/** Mirrors loadDashboard's closed-list construction. */
function closedList(rows: Row[]) {
  return rows
    .filter((p) => p.shares <= 0)
    .filter((p) => !isPhantomClosedPosition({ costBasis: p.cost_basis, realizedPnl: p.realized_pnl }))
    .map((p) => ({ asset: p.asset, settlementStatus: p.settlement_status }));
}

describe("phantom closed positions", () => {
  it("writes no paper_positions row when a never-opened asset only produces SKIPs", () => {
    // SELL with no source state and no paper shares => SKIP.
    const { rows, cash } = runBatch({
      events: [
        { asset: "never", side: "SELL", price: 0.4, shares: 10 },
        { asset: "never", side: "SELL", price: 0.4, shares: 5 },
      ],
      startingCash: 380,
      cash: 380,
    });
    expect(rows).toEqual([]);
    expect(cash).toBe(380);
  });

  it("BUY then SELL-to-zero writes exactly one closed row with non-zero realized P&L", () => {
    const { rows } = runBatch({
      events: [
        { asset: "a", side: "BUY", price: 0.5, shares: 100 },
        { asset: "a", side: "SELL", price: 0.8, shares: 100 },
      ],
      startingCash: 380,
      cash: 380,
    });
    expect(rows).toHaveLength(1);
    const row = rows[0] as Row;
    expect(row.shares).toBe(0);
    expect(row.settlement_status).toBe("closed");
    expect(row.realized_pnl).toBeGreaterThan(0);
  });

  it("realized P&L for a genuine close is unchanged by the write-gate", () => {
    const buy = decideDynamicBuy({ price: 0.5, startingCash: 380, cash: 380 });
    const opened = applyBuy(EMPTY_POSITION, 380, buy.shares, buy.notional);
    const sold = applySell(opened.position, opened.cash, opened.position.shares, 0.8);
    const { rows } = runBatch({
      events: [
        { asset: "a", side: "BUY", price: 0.5, shares: 100 },
        { asset: "a", side: "SELL", price: 0.8, shares: 100 },
      ],
      startingCash: 380,
      cash: 380,
    });
    expect((rows[0] as Row).realized_pnl).toBe(sold.position.realizedPnl);
  });

  it("keeps updating an asset that already had a row, even on SKIP-only batches", () => {
    const existing = new Map<string, PaperPositionState>([
      ["a", { shares: 5, costBasis: 2.5, avgPrice: 0.5, realizedPnl: 1.25 }],
    ]);
    const { rows } = runBatch({
      events: [{ asset: "a", side: "SELL", price: 0, shares: 1 }],
      startingCash: 380,
      cash: 380,
      existing,
    });
    expect(rows.map((r) => r.asset)).toEqual(["a"]);
  });

  it("dashboard closed list drops phantom rows and keeps genuine closes and settlements", () => {
    const rows: Row[] = [
      { asset: "phantom", shares: 0, cost_basis: 0, realized_pnl: 0, settlement_status: "closed" },
      { asset: "sold", shares: 0, cost_basis: 0, realized_pnl: 1.4, settlement_status: "closed" },
      { asset: "won", shares: 0, cost_basis: 0, realized_pnl: 2.6, settlement_status: "settled_won" },
      {
        asset: "lost",
        shares: 0,
        cost_basis: 0,
        realized_pnl: -1.1,
        settlement_status: "settled_lost",
      },
      { asset: "open", shares: 3, cost_basis: 1.5, realized_pnl: 0, settlement_status: "open" },
    ];
    expect(closedList(rows)).toEqual([
      { asset: "sold", settlementStatus: "closed" },
      { asset: "won", settlementStatus: "settled_won" },
      { asset: "lost", settlementStatus: "settled_lost" },
    ]);
  });

  it("cash is unchanged by SKIP-only batches (no bankroll drift from this fix)", () => {
    const before = 381.11;
    const { cash } = runBatch({
      events: [
        { asset: "x", side: "SELL", price: 0.3, shares: 4 },
        { asset: "y", side: "SELL", price: 0.7, shares: 9 },
      ],
      startingCash: 380,
      cash: before,
    });
    expect(cash).toBe(before);
  });
});
