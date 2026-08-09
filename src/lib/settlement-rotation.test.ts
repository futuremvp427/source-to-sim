import { describe, expect, it } from "vitest";

import { decideResolution, selectSettlementBatch, SETTLEMENT_BATCH_SIZE } from "./settlement-core";

function coverage(openCount: number, passes: number): Set<number> {
  const seen = new Set<number>();
  for (let cycle = 0; cycle < passes; cycle++) {
    const b = selectSettlementBatch(openCount, cycle);
    for (let i = b.offset; i < b.offset + b.size; i++) seen.add(i);
  }
  return seen;
}

describe("rotating settlement scan", () => {
  it("checks all 10 open positions in one pass", () => {
    expect(selectSettlementBatch(10, 0)).toEqual({ offset: 0, size: 10, batchIndex: 0, batchCount: 1 });
    expect(coverage(10, 1).size).toBe(10);
  });

  it("covers 49 positions within 2 passes", () => {
    expect(selectSettlementBatch(49, 0).batchCount).toBe(2);
    expect(coverage(49, 2).size).toBe(49);
  });

  it("covers 76 positions within 4 passes", () => {
    expect(selectSettlementBatch(76, 0).batchCount).toBe(4);
    expect(coverage(76, 4).size).toBe(76);
  });

  it("never exceeds the per-pass lookup budget", () => {
    for (let c = 0; c < 8; c++) expect(selectSettlementBatch(76, c).size).toBeLessThanOrEqual(SETTLEMENT_BATCH_SIZE);
  });

  it("is deterministic for the same cycle index", () => {
    expect(selectSettlementBatch(76, 5)).toEqual(selectSettlementBatch(76, 5));
    expect(selectSettlementBatch(76, 1).offset).toBe(25);
  });

  it("wraps around after the final batch", () => {
    expect(selectSettlementBatch(76, 3).batchIndex).toBe(3);
    expect(selectSettlementBatch(76, 4).batchIndex).toBe(0);
    expect(selectSettlementBatch(76, -1).batchIndex).toBe(3);
  });

  it("handles an empty book", () => {
    expect(selectSettlementBatch(0, 3)).toEqual({ offset: 0, size: 0, batchIndex: 0, batchCount: 0 });
  });

  it("keeps verified winner/loser settlement behaviour unchanged", () => {
    const market = {
      closed: true,
      tokens: [
        { tokenId: "A", outcome: "Yes", winner: true },
        { tokenId: "B", outcome: "No", winner: false },
      ],
    };
    expect(decideResolution("A", market)).toMatchObject({ verified: true, won: true, payoutPerShare: 1 });
    expect(decideResolution("B", market)).toMatchObject({ verified: true, won: false, payoutPerShare: 0 });
    expect(decideResolution("A", { ...market, closed: false })).toMatchObject({ verified: false });
  });
});
