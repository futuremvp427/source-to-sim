import { describe, expect, it } from "vitest";

import {
  decideResolution,
  selectSettlementBatchByCursor,
  SETTLEMENT_BATCH_SIZE,
} from "./settlement-core";

function assets(n: number): string[] {
  return Array.from({ length: n }, (_, i) => `asset-${String(i).padStart(3, "0")}`);
}

function completedPassCoverage(openAssets: string[], passes: number): Set<string> {
  const seen = new Set<string>();
  let cursor: string | null = null;
  for (let pass = 0; pass < passes; pass += 1) {
    const batch = selectSettlementBatchByCursor(openAssets, cursor);
    for (const asset of batch.assets) seen.add(asset);
    cursor = batch.nextCursor;
  }
  return seen;
}

describe("cursor-driven settlement scan", () => {
  it("checks all 10 open positions in one completed pass", () => {
    const batch = selectSettlementBatchByCursor(assets(10), null);
    expect(batch.assets).toEqual(assets(10));
    expect(batch.nextCursor).toBe("asset-009");
    expect(completedPassCoverage(assets(10), 1).size).toBe(10);
  });

  it("covers 49 positions within 2 completed passes regardless of wall-clock timing", () => {
    expect(completedPassCoverage(assets(49), 2).size).toBe(49);
  });

  it("covers 76 positions within 4 completed passes", () => {
    expect(completedPassCoverage(assets(76), 4).size).toBe(76);
  });

  it("never exceeds the per-pass lookup budget", () => {
    let cursor: string | null = null;
    for (let pass = 0; pass < 8; pass += 1) {
      const batch = selectSettlementBatchByCursor(assets(76), cursor);
      expect(batch.assets.length).toBeLessThanOrEqual(SETTLEMENT_BATCH_SIZE);
      cursor = batch.nextCursor;
    }
  });

  it("resumes after the last asset actually scanned instead of using minute parity", () => {
    const open = assets(49);
    const first = selectSettlementBatchByCursor(open, null);
    expect(first.assets.at(-1)).toBe("asset-024");
    const second = selectSettlementBatchByCursor(open, first.nextCursor);
    expect(second.assets[0]).toBe("asset-025");
    expect(second.assets).toContain("asset-048");
  });

  it("continues correctly if the cursor asset disappeared after settlement", () => {
    const open = assets(10).filter((asset) => asset !== "asset-004");
    const batch = selectSettlementBatchByCursor(open, "asset-004", 3);
    expect(batch.assets).toEqual(["asset-005", "asset-006", "asset-007"]);
  });

  it("wraps to the beginning after the end of the sorted open book", () => {
    const batch = selectSettlementBatchByCursor(assets(10), "asset-008", 4);
    expect(batch.assets).toEqual(["asset-009", "asset-000", "asset-001", "asset-002"]);
    expect(batch.wrapped).toBe(true);
    expect(batch.nextCursor).toBe("asset-002");
  });

  it("handles an empty book", () => {
    expect(selectSettlementBatchByCursor([], "asset-123")).toEqual({
      assets: [],
      startIndex: 0,
      batchIndex: 0,
      batchCount: 0,
      wrapped: false,
      nextCursor: "asset-123",
    });
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
