import { describe, expect, it } from "vitest";

import {
  evaluateHistoricalSettlementEquivalence,
  samePriceBuyHoldPnl,
  wouldResolveYes,
  type HistoricalSettlementObservation,
} from "./weather-settlement-equivalence";

const historicalObservations: readonly HistoricalSettlementObservation[] = [
  {
    id: "KLAX-2026-04-29-52-53",
    station: "KLAX",
    date: "2026-04-29",
    contract: { kind: "range", lowF: 52, highF: 53 },
    sourceResolvedYes: false,
    nwsHighF: 70,
  },
  {
    id: "KLAX-2026-06-05-58-59",
    station: "KLAX",
    date: "2026-06-05",
    contract: { kind: "range", lowF: 58, highF: 59 },
    sourceResolvedYes: false,
    nwsHighF: 70,
  },
  {
    id: "KLAX-2026-07-09-74-75",
    station: "KLAX",
    date: "2026-07-09",
    contract: { kind: "range", lowF: 74, highF: 75 },
    sourceResolvedYes: true,
    nwsHighF: 74,
  },
  {
    id: "KLAX-2026-08-20-78-79",
    station: "KLAX",
    date: "2026-08-20",
    contract: { kind: "range", lowF: 78, highF: 79 },
    sourceResolvedYes: false,
    nwsHighF: 77,
  },
  {
    id: "KSFO-2026-07-03-68-69",
    station: "KSFO",
    date: "2026-07-03",
    contract: { kind: "range", lowF: 68, highF: 69 },
    sourceResolvedYes: true,
    nwsHighF: 70,
  },
  {
    id: "KSFO-2026-08-20-64-65",
    station: "KSFO",
    date: "2026-08-20",
    contract: { kind: "range", lowF: 64, highF: 65 },
    sourceResolvedYes: false,
    nwsHighF: 69,
  },
  {
    id: "KMIA-2026-06-05-73-or-below",
    station: "KMIA",
    date: "2026-06-05",
    contract: { kind: "at_or_below", valueF: 73 },
    sourceResolvedYes: false,
    nwsHighF: 85,
  },
  {
    id: "KMIA-2026-06-20-78-79",
    station: "KMIA",
    date: "2026-06-20",
    contract: { kind: "range", lowF: 78, highF: 79 },
    sourceResolvedYes: false,
    nwsHighF: 93,
  },
  {
    id: "KMIA-2026-07-10-92-93",
    station: "KMIA",
    date: "2026-07-10",
    contract: { kind: "range", lowF: 92, highF: 93 },
    sourceResolvedYes: true,
    nwsHighF: 93,
  },
] as const;

describe("historical weather settlement-source replay", () => {
  it("records the observed 8/9 agreement and blocks promotion after one real divergence", () => {
    const result = evaluateHistoricalSettlementEquivalence(historicalObservations);

    expect(result.independentObservations).toBe(9);
    expect(result.observationRows).toBe(9);
    expect(result.duplicateObservations).toBe(0);
    expect(result.agreements).toBe(8);
    expect(result.divergences).toBe(1);
    expect(result.agreementRate).toBeCloseTo(8 / 9, 10);
    expect(result.status).toBe("DIVERGENCE_OBSERVED");
    expect(result.exactMatchEligible).toBe(false);
    expect(result.paperResearchPromotionEligible).toBe(false);
  });

  it("locks the KSFO July 3 counterexample: source YES, NWS-style bucket NO", () => {
    const counterexample = historicalObservations.find(
      (observation) => observation.id === "KSFO-2026-07-03-68-69",
    );

    expect(counterexample).toBeDefined();
    expect(counterexample?.sourceResolvedYes).toBe(true);
    expect(counterexample?.nwsHighF).toBe(70);
    expect(
      wouldResolveYes(counterexample!.contract, counterexample!.nwsHighF),
    ).toBe(false);
  });

  it("does not inflate independent evidence with multiple buckets from one station-day", () => {
    const duplicateStationDay: HistoricalSettlementObservation = {
      id: "KLAX-2026-04-29-70-71",
      station: "KLAX",
      date: "2026-04-29",
      contract: { kind: "range", lowF: 70, highF: 71 },
      sourceResolvedYes: true,
      nwsHighF: 70,
    };

    const result = evaluateHistoricalSettlementEquivalence([
      ...historicalObservations,
      duplicateStationDay,
    ]);

    expect(result.observationRows).toBe(10);
    expect(result.independentObservations).toBe(9);
    expect(result.duplicateObservations).toBe(1);
    expect(result.divergences).toBe(1);
  });

  it("still never grants EXACT_MATCH after a large zero-divergence research sample", () => {
    const zeroDivergence = Array.from({ length: 30 }, (_, index) => ({
      id: `KLAX-2026-01-${String(index + 1).padStart(2, "0")}`,
      station: "KLAX" as const,
      date: `2026-01-${String(index + 1).padStart(2, "0")}`,
      contract: { kind: "range" as const, lowF: 70, highF: 71 },
      sourceResolvedYes: true,
      nwsHighF: 70,
    }));

    const result = evaluateHistoricalSettlementEquivalence(zeroDivergence, 30);

    expect(result.status).toBe("NO_DIVERGENCE_OBSERVED");
    expect(result.paperResearchPromotionEligible).toBe(true);
    expect(result.exactMatchEligible).toBe(false);
  });

  it("returns insufficient data when no divergence is observed below the preregistered floor", () => {
    const result = evaluateHistoricalSettlementEquivalence(
      historicalObservations.filter((observation) => observation.station === "KLAX"),
      30,
    );

    expect(result.status).toBe("INSUFFICIENT_DATA");
    expect(result.exactMatchEligible).toBe(false);
  });
});

describe("same-source-price BUY/hold sensitivity", () => {
  it("reproduces the six observed BUY examples without pretending they are historical PM-US fills", () => {
    const buys = [
      { shares: 1020.05, price: 0.001, resolvedYes: false },
      { shares: 2926.09, price: 0.001, resolvedYes: false },
      { shares: 105.5, price: 0.228, resolvedYes: false },
      { shares: 322.8, price: 0.105, resolvedYes: false },
      { shares: 1500.87, price: 0.001, resolvedYes: false },
      { shares: 5866.25, price: 0.002, resolvedYes: false },
    ] as const;

    const total = buys.reduce((sum, buy) => sum + samePriceBuyHoldPnl(buy), 0);
    expect(total).toBeCloseTo(-75.12751, 5);
  });

  it("computes winning YES hold PnL", () => {
    expect(samePriceBuyHoldPnl({ shares: 100, price: 0.25, resolvedYes: true })).toBe(75);
  });

  it("rejects invalid prices and share counts", () => {
    expect(() => samePriceBuyHoldPnl({ shares: 1, price: -0.01, resolvedYes: false })).toThrow();
    expect(() => samePriceBuyHoldPnl({ shares: 1, price: 1.01, resolvedYes: true })).toThrow();
    expect(() => samePriceBuyHoldPnl({ shares: -1, price: 0.5, resolvedYes: true })).toThrow();
  });
});
