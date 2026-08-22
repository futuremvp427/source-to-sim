import { describe, expect, it, vi } from "vitest";

import { runSettlementBatch, settlePosition, type OpenPaperPosition, type SettlementRepository, type SettlementRow } from "./settlement.orchestrator.server";

function position(overrides: Partial<OpenPaperPosition> = {}): OpenPaperPosition {
  return {
    signalId: "sig-1",
    venue: "PMUS",
    notionalTierUsd: 10,
    targetMarketId: "some-slug",
    selectedSide: "TEAM:NYY:LONG",
    entryContracts: 20,
    entryAllInCostUsd: 10.5,
    ...overrides,
  };
}

function fetchReturning(body: unknown): typeof fetch {
  return vi.fn(async () => new Response(JSON.stringify(body), { status: 200 })) as unknown as typeof fetch;
}

describe("FINAL BUILD Part 15: settlePosition", () => {
  it("a WIN computes gross/net P&L as contracts*1 minus entry cost", async () => {
    const fetchImpl = fetchReturning({ markets: [{ status: "MARKET_STATUS_RESOLVED", marketSides: [{ long: true, price: "1" }, { long: false, price: "0" }] }] });
    const row = await settlePosition(position(), fetchImpl);
    expect(row.settlementStatus).toBe("SETTLED_WIN");
    expect(row.grossPnlUsd).toBeCloseTo(20 * 1 - 10.5, 6);
    expect(row.netPnlUsd).toBe(row.grossPnlUsd);
  });

  it("a LOSS computes gross P&L as 0 minus entry cost (a full loss of the stake)", async () => {
    const fetchImpl = fetchReturning({ markets: [{ status: "MARKET_STATUS_RESOLVED", marketSides: [{ long: true, price: "0" }, { long: false, price: "1" }] }] });
    const row = await settlePosition(position(), fetchImpl);
    expect(row.settlementStatus).toBe("SETTLED_LOSS");
    expect(row.grossPnlUsd).toBeCloseTo(-10.5, 6);
  });

  it("a still-pending market produces a PENDING row with null P&L -- never fabricated", async () => {
    const fetchImpl = fetchReturning({ markets: [{ status: "MARKET_STATUS_ACTIVE" }] });
    const row = await settlePosition(position(), fetchImpl);
    expect(row.settlementStatus).toBe("PENDING");
    expect(row.grossPnlUsd).toBeNull();
    expect(row.netPnlUsd).toBeNull();
  });

  it("Kalshi position resolves using the YES/NO side from selected_side", async () => {
    const fetchImpl = fetchReturning({ market: { status: "finalized", result: "yes", settlement_value_dollars: "1.0000" } });
    const row = await settlePosition(position({ venue: "KALSHI", selectedSide: "YES" }), fetchImpl);
    expect(row.settlementStatus).toBe("SETTLED_WIN");
  });

  it("a position with unresolvable side orientation is VOID without ever calling the network", async () => {
    const fetchImpl = vi.fn();
    const row = await settlePosition(position({ selectedSide: "GARBAGE" }), fetchImpl as unknown as typeof fetch);
    expect(row.settlementStatus).toBe("VOID");
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

describe("FINAL BUILD Part 15: runSettlementBatch", () => {
  it("settles multiple open positions, tallying settled vs still-pending", async () => {
    const positions = [position({ signalId: "a" }), position({ signalId: "b" })];
    const upserted: SettlementRow[] = [];
    const repo: SettlementRepository = {
      async findOpenPositions() {
        return positions;
      },
      async upsertSettlement(row) {
        upserted.push(row);
      },
    };
    const fetchImpl = fetchReturning({ markets: [{ status: "MARKET_STATUS_RESOLVED", marketSides: [{ long: true, price: "1" }, { long: false, price: "0" }] }] });
    const summary = await runSettlementBatch(50, repo, fetchImpl);
    expect(summary.checked).toBe(2);
    expect(summary.settled).toBe(2);
    expect(upserted).toHaveLength(2);
  });

  it("one position's failure does not abort the batch for the rest", async () => {
    const positions = [position({ signalId: "a", targetMarketId: "" }), position({ signalId: "b" })];
    const upserted: SettlementRow[] = [];
    const repo: SettlementRepository = {
      async findOpenPositions() {
        return positions;
      },
      async upsertSettlement(row) {
        upserted.push(row);
      },
    };
    let calls = 0;
    const fetchImpl = vi.fn(async () => {
      calls += 1;
      if (calls === 1) throw new Error("network exploded");
      return new Response(JSON.stringify({ markets: [{ status: "MARKET_STATUS_RESOLVED", marketSides: [{ long: true, price: "1" }, { long: false, price: "0" }] }] }), { status: 200 });
    }) as unknown as typeof fetch;
    const summary = await runSettlementBatch(50, repo, fetchImpl);
    expect(summary.checked).toBe(2);
    expect(summary.errors).toBe(1);
    expect(summary.settled).toBe(1);
    expect(upserted).toHaveLength(1); // the failed position's row was never upserted
  });
});
