import { describe, expect, it } from "vitest";
import { budgetExceeded, derivePendingSignals, detectedAtMsFromSignal, toSourceSignal, type ExistingMatchRow, type SignalRow } from "./worker";

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
    ...overrides,
  };
}

describe("derivePendingSignals", () => {
  it("a signal with no match rows at all is pending for both venues", () => {
    const pending = derivePendingSignals([signal()], []);
    expect(pending).toHaveLength(1);
    expect(pending[0]).toMatchObject({ missingPmus: true, missingKalshi: true });
  });

  it("a signal missing PMUS only does not redo an already-completed Kalshi result", () => {
    const matches: ExistingMatchRow[] = [{ signalId: "sig-1", venue: "KALSHI" }];
    const pending = derivePendingSignals([signal()], matches);
    expect(pending[0]).toMatchObject({ missingPmus: true, missingKalshi: false });
  });

  it("a signal missing Kalshi only does not redo an already-completed PMUS result", () => {
    const matches: ExistingMatchRow[] = [{ signalId: "sig-1", venue: "PMUS" }];
    const pending = derivePendingSignals([signal()], matches);
    expect(pending[0]).toMatchObject({ missingPmus: false, missingKalshi: true });
  });

  it("a signal with both venues already resolved is excluded entirely", () => {
    const matches: ExistingMatchRow[] = [{ signalId: "sig-1", venue: "PMUS" }, { signalId: "sig-1", venue: "KALSHI" }];
    const pending = derivePendingSignals([signal()], matches);
    expect(pending).toHaveLength(0);
  });

  it("oldest first, by createdAtIso ascending", () => {
    const s1 = signal({ id: "sig-old", createdAtIso: "2026-08-19T00:00:00.000Z" });
    const s2 = signal({ id: "sig-new", createdAtIso: "2026-08-19T01:00:00.000Z" });
    const pending = derivePendingSignals([s2, s1], []); // deliberately reversed input order
    expect(pending.map((p) => p.id)).toEqual(["sig-old", "sig-new"]);
  });

  it("is bounded to batchSize, leaving remaining pending signals out of this cycle's batch", () => {
    const signals = Array.from({ length: 5 }, (_, i) => signal({ id: `sig-${i}`, createdAtIso: `2026-08-19T00:0${i}:00.000Z` }));
    const pending = derivePendingSignals(signals, [], 3);
    expect(pending).toHaveLength(3);
    expect(pending.map((p) => p.id)).toEqual(["sig-0", "sig-1", "sig-2"]);
  });

  it("deterministic: identical input always produces identical output regardless of call count", () => {
    const signals = [signal({ id: "sig-a" }), signal({ id: "sig-b", createdAtIso: "2026-08-19T00:01:00.000Z" })];
    const first = derivePendingSignals(signals, []);
    const second = derivePendingSignals(signals, []);
    expect(first).toEqual(second);
  });

  it("restart-safe: derivation depends only on the passed-in durable snapshot, never on any external/hidden state", () => {
    // Calling twice with the SAME arguments (simulating two separate process instances
    // reading the same durable DB state) yields the same result -- no module-level cache exists in worker.ts to diverge.
    const signals = [signal()];
    const matches: ExistingMatchRow[] = [{ signalId: "sig-1", venue: "PMUS" }];
    expect(derivePendingSignals(signals, matches)).toEqual(derivePendingSignals(signals, matches));
  });
});

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
