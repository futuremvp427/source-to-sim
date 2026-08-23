import { describe, expect, it, vi } from "vitest";

import {
  computeNextSettlementCheckAtMs,
  runSettlementBatch,
  settlePosition,
  SETTLEMENT_RECHECK_BASE_MS,
  SETTLEMENT_RECHECK_MAX_MS,
  type OpenPaperPosition,
  type SettlementRepository,
  type SettlementRow,
} from "./settlement.orchestrator.server";

function position(overrides: Partial<OpenPaperPosition> = {}): OpenPaperPosition {
  return {
    signalId: "sig-1",
    venue: "PMUS",
    notionalTierUsd: 10,
    targetMarketId: "some-slug",
    selectedSide: "TEAM:NYY:LONG",
    entryContracts: 20,
    entryAllInCostUsd: 10.5,
    checkAttemptCount: 0,
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

  it("CODEX P2-3: a still-PENDING position persists an incremented checkAttemptCount and a future nextCheckAtMs -- never re-selected on the very next cycle", async () => {
    const positions = [position({ signalId: "a", checkAttemptCount: 2 })];
    const upserted: SettlementRow[] = [];
    const repo: SettlementRepository = {
      async findOpenPositions() {
        return positions;
      },
      async upsertSettlement(row) {
        upserted.push(row);
      },
    };
    const fetchImpl = fetchReturning({ markets: [{ status: "MARKET_STATUS_ACTIVE" }] });
    const nowMs = 1_700_000_000_000;
    await runSettlementBatch(50, repo, fetchImpl, () => nowMs);
    expect(upserted).toHaveLength(1);
    expect(upserted[0]?.settlementStatus).toBe("PENDING");
    expect(upserted[0]?.checkAttemptCount).toBe(3); // 2 -> 3, this check counted
    expect(upserted[0]?.nextCheckAtMs).toBe(computeNextSettlementCheckAtMs(nowMs, 3));
    expect(upserted[0]?.nextCheckAtMs!).toBeGreaterThan(nowMs);
  });

  it("CODEX P2-3: a terminally-settled position persists nextCheckAtMs=null -- no further checks needed", async () => {
    const positions = [position({ signalId: "a", checkAttemptCount: 5 })];
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
    await runSettlementBatch(50, repo, fetchImpl);
    expect(upserted[0]?.settlementStatus).toBe("SETTLED_WIN");
    expect(upserted[0]?.nextCheckAtMs).toBeNull();
    expect(upserted[0]?.checkAttemptCount).toBe(6);
  });
});

describe("CODEX P2-3: computeNextSettlementCheckAtMs -- exponential backoff for a persistently-PENDING position", () => {
  it("the FIRST check (attemptCountAfterThisCheck=1) uses the 10-minute base, not the ceiling", () => {
    const nowMs = 1_700_000_000_000;
    expect(computeNextSettlementCheckAtMs(nowMs, 1)).toBe(nowMs + SETTLEMENT_RECHECK_BASE_MS);
  });

  it("doubles per additional attempt", () => {
    const nowMs = 1_700_000_000_000;
    expect(computeNextSettlementCheckAtMs(nowMs, 2)).toBe(nowMs + SETTLEMENT_RECHECK_BASE_MS * 2);
    expect(computeNextSettlementCheckAtMs(nowMs, 3)).toBe(nowMs + SETTLEMENT_RECHECK_BASE_MS * 4);
  });

  it("is capped at SETTLEMENT_RECHECK_MAX_MS regardless of how many attempts have accumulated", () => {
    const nowMs = 1_700_000_000_000;
    expect(computeNextSettlementCheckAtMs(nowMs, 20)).toBe(nowMs + SETTLEMENT_RECHECK_MAX_MS);
    expect(computeNextSettlementCheckAtMs(nowMs, 1000)).toBe(nowMs + SETTLEMENT_RECHECK_MAX_MS);
  });

  it("never returns a time at/before now -- always strictly in the future", () => {
    const nowMs = 1_700_000_000_000;
    for (const attempt of [1, 2, 5, 10, 50]) {
      expect(computeNextSettlementCheckAtMs(nowMs, attempt)).toBeGreaterThan(nowMs);
    }
  });
});
