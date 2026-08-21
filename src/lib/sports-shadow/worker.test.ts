import { describe, expect, it } from "vitest";
import { budgetExceeded, detectedAtMsFromSignal, toSourceSignal, type SignalRow } from "./worker";

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
