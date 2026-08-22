import { describe, expect, it } from "vitest";
import { budgetExceeded, detectedAtMsFromSignal, nextRotationIndex, rotateWallets, toSourceSignal, type SignalRow } from "./worker";

function signal(overrides: Partial<SignalRow> = {}): SignalRow {
  return {
    id: "sig-1",
    createdAtIso: "2026-08-19T00:00:00.000Z",
    sourceFirstFillAtIso: "2026-08-18T23:55:00.000Z",
    wallet: "0xa71093cafc0c099b4ccab24c3cb8018d817923c4",
    conditionId: "0xcondition-1",
    asset: "0xasset-1",
    betType: "MONEYLINE",
    awayTeam: "NYY",
    homeTeam: "BAL",
    scheduledStartAt: "2026-08-19T22:35:00Z",
    line: null,
    selectedOutcomeRaw: "New York Yankees",
    eventSlug: "mlb-nyy-bal-2026-08-19",
    marketSlug: "mlb-nyy-bal-2026-08-19",
    sourceRulesDescription: null,
    ...overrides,
  };
}

describe("toSourceSignal", () => {
  it("maps a pending signal row into a resolver SourceSignal", () => {
    const source = toSourceSignal(signal());
    expect(source).toEqual({
      betType: "MONEYLINE",
      awayTeam: "NYY",
      homeTeam: "BAL",
      gameStartTime: "2026-08-19T22:35:00Z",
      line: null,
      selectedOutcomeRaw: "New York Yankees",
      conditionId: "0xcondition-1",
      sourceGameId: null,
      eventSlug: "mlb-nyy-bal-2026-08-19",
      marketSlug: "mlb-nyy-bal-2026-08-19",
      sourceRulesDescription: null,
    });
  });

  it("returns null when conditionId is missing rather than fabricating one", () => {
    expect(toSourceSignal(signal({ conditionId: null }))).toBeNull();
  });

  it("never turns a raw BUY-side selectedOutcomeRaw into an assumed YES/NO -- passes the raw text through untouched", () => {
    const source = toSourceSignal(signal({ selectedOutcomeRaw: "New York Yankees" }));
    expect(source?.selectedOutcomeRaw).toBe("New York Yankees");
  });
});

describe("detectedAtMsFromSignal", () => {
  it("uses the signal's durable createdAtIso, never the source's historical fill timestamp", () => {
    const row = signal({ createdAtIso: "2026-08-19T00:00:00.000Z", sourceFirstFillAtIso: "2026-08-01T00:00:00.000Z" });
    expect(detectedAtMsFromSignal(row)).toBe(Date.parse("2026-08-19T00:00:00.000Z"));
    expect(detectedAtMsFromSignal(row)).not.toBe(Date.parse(row.sourceFirstFillAtIso));
  });
});

describe("budgetExceeded", () => {
  it("false while under budget", () => {
    expect(budgetExceeded(1000, 30_000)).toBe(false);
  });
  it("true once elapsed meets or exceeds the budget", () => {
    expect(budgetExceeded(30_000, 30_000)).toBe(true);
    expect(budgetExceeded(31_000, 30_000)).toBe(true);
  });
});

describe("rotateWallets", () => {
  it("startIndex 0 returns the original order unchanged", () => {
    expect(rotateWallets(["A", "B", "C"], 0)).toEqual(["A", "B", "C"]);
  });

  it("rotates so wallet at startIndex becomes first", () => {
    expect(rotateWallets(["A", "B", "C"], 1)).toEqual(["B", "C", "A"]);
    expect(rotateWallets(["A", "B", "C"], 2)).toEqual(["C", "A", "B"]);
  });

  it("wraps a startIndex equal to the cohort length back to the original order", () => {
    expect(rotateWallets(["A", "B", "C"], 3)).toEqual(["A", "B", "C"]);
  });

  it("wraps an out-of-range startIndex safely (e.g. a stale cursor from a since-shrunk cohort)", () => {
    expect(rotateWallets(["A", "B", "C"], 100)).toEqual(rotateWallets(["A", "B", "C"], 1));
  });

  it("never crashes or produces an out-of-bounds result for a single-wallet cohort", () => {
    expect(rotateWallets(["A"], 5)).toEqual(["A"]);
  });

  it("returns an empty array for an empty cohort, never throws", () => {
    expect(rotateWallets([], 3)).toEqual([]);
  });

  it("preserves every wallet exactly once regardless of startIndex", () => {
    const wallets = ["A", "B", "C", "D", "E"];
    for (let i = 0; i < 10; i += 1) {
      expect([...rotateWallets(wallets, i)].sort()).toEqual([...wallets].sort());
    }
  });
});

describe("nextRotationIndex", () => {
  it("advances by exactly the number of wallets attempted", () => {
    expect(nextRotationIndex(0, 2, 5)).toBe(2);
  });

  it("wraps modulo the total wallet count once it reaches the end", () => {
    expect(nextRotationIndex(3, 2, 5)).toBe(0);
    expect(nextRotationIndex(4, 3, 5)).toBe(2);
  });

  it("a fully-completed cycle (all wallets attempted) wraps back to the start", () => {
    expect(nextRotationIndex(0, 5, 5)).toBe(0);
  });

  it("a partial cycle (budget exhausted after only 1 wallet) still advances -- this is what prevents permanent starvation of later wallets", () => {
    expect(nextRotationIndex(0, 1, 3)).toBe(1);
  });

  it("zero wallets attempted (e.g. the lane never ran) leaves the cursor unchanged", () => {
    expect(nextRotationIndex(2, 0, 5)).toBe(2);
  });

  it("returns 0 for an empty cohort, never divides by zero", () => {
    expect(nextRotationIndex(3, 0, 0)).toBe(0);
  });

  it("handles a stale startIndex from a since-shrunk cohort without going negative or out of range", () => {
    const next = nextRotationIndex(50, 2, 3);
    expect(next).toBeGreaterThanOrEqual(0);
    expect(next).toBeLessThan(3);
  });
});

describe("rotateWallets + nextRotationIndex fairness property", () => {
  it("over enough cycles, every wallet in the cohort eventually becomes the first wallet attempted", () => {
    const wallets = ["A", "B", "C", "D"];
    let cursor = 0;
    const firstWalletSeen = new Set<string>();
    // Simulate a persistently slow first wallet: every cycle attempts exactly ONE wallet
    // before "hitting its budget" -- the worst case for fairness.
    for (let cycle = 0; cycle < wallets.length; cycle += 1) {
      const ordered = rotateWallets(wallets, cursor);
      firstWalletSeen.add(ordered[0]!);
      cursor = nextRotationIndex(cursor, 1, wallets.length);
    }
    expect(firstWalletSeen).toEqual(new Set(wallets)); // every wallet got a turn as first
  });
});
