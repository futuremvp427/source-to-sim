import { describe, expect, it } from "bun:test";

import { derivePaperActions, normalizeTrades } from "./mirror-trader";

const identicalBuys = [
  {
    side: "BUY",
    asset: "a1",
    conditionId: "c1",
    size: 10,
    price: 0.5,
    timestamp: 1786120000,
    title: "Same second market",
    outcome: "Yes",
    transactionHash: "0xsametx",
  },
  {
    side: "BUY",
    asset: "a1",
    conditionId: "c1",
    size: 10,
    price: 0.5,
    timestamp: 1786120000,
    title: "Same second market",
    outcome: "Yes",
    transactionHash: "0xsametx",
  },
];

const identicalSells = identicalBuys.map((t) => ({ ...t, side: "SELL" }));

describe("trade identity", () => {
  it("keeps two identical same-second BUYs distinct", () => {
    const trades = normalizeTrades(identicalBuys);
    expect(trades).toHaveLength(2);
    expect(new Set(trades.map((t) => t.id)).size).toBe(2);
  });

  it("keeps two identical same-second SELLs distinct", () => {
    const trades = normalizeTrades(identicalSells);
    expect(trades).toHaveLength(2);
    expect(new Set(trades.map((t) => t.id)).size).toBe(2);
  });

  it("is deterministic across repeated normalization", () => {
    expect(normalizeTrades(identicalBuys).map((t) => t.id)).toEqual(
      normalizeTrades(identicalBuys).map((t) => t.id),
    );
  });

  it("dedupes genuine repeats that carry a source id", () => {
    const trades = normalizeTrades([
      { ...identicalBuys[0], id: "t-1" },
      { ...identicalBuys[0], id: "t-1" },
      { ...identicalBuys[0], id: "t-2" },
    ]);
    expect(trades).toHaveLength(2);
    expect(trades.every((t) => t.idBasis === "source_id")).toBe(true);
  });

  it("prefers tx hash + log index when available", () => {
    const trades = normalizeTrades([
      { ...identicalBuys[0], logIndex: 3 },
      { ...identicalBuys[0], logIndex: 4 },
    ]);
    expect(trades.map((t) => t.idBasis)).toEqual(["tx_hash_log_index", "tx_hash_log_index"]);
    expect(new Set(trades.map((t) => t.id)).size).toBe(2);
  });
});

describe("paper derivation", () => {
  it("produces one paper action per distinct source trade", () => {
    const actions = derivePaperActions(normalizeTrades(identicalBuys), 10);
    expect(actions).toHaveLength(2);
    expect(actions.every((a) => a.notional === 10)).toBe(true);
    expect(actions[0]!.shares).toBe(20);
  });
});