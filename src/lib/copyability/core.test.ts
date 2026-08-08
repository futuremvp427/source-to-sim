import { describe, expect, it } from "vitest";

import {
  computeObservation,
  copyabilityScore,
  midpointOf,
  spreadCents,
  type ObservationLite,
  type SampleDelay,
} from "./core";

const book = (bestBid: number | null, bestAsk: number | null, visibleDepth: number | null = null) => ({
  bestBid,
  bestAsk,
  midpoint: null,
  visibleDepth,
});

describe("observation math", () => {
  it("keeps missing CLOB data null and never invents a value", () => {
    const o = computeObservation({ side: "BUY", leaderPrice: 0.5, requiredShares: 10, sample: book(null, null) });
    expect(o.followerPrice).toBeNull();
    expect(o.spread).toBeNull();
    expect(o.midpoint).toBeNull();
    expect(o.slippageCents).toBeNull();
    expect(o.slippagePct).toBeNull();
    expect(o.improved).toBeNull();
    expect(o.priceDirection).toBeNull();
    expect(o.fillable).toBeNull();
  });

  it("BUY slippage uses the follower ASK", () => {
    const o = computeObservation({ side: "BUY", leaderPrice: 0.5, requiredShares: null, sample: book(0.48, 0.53) });
    expect(o.followerPrice).toBe(0.53);
    expect(o.slippageCents).toBeCloseTo(3, 6);
    expect(o.slippagePct).toBeCloseTo(6, 4);
    expect(o.improved).toBe(false);
    expect(o.priceDirection).toBe("UP");
  });

  it("SELL slippage uses the follower BID", () => {
    const o = computeObservation({ side: "SELL", leaderPrice: 0.5, requiredShares: null, sample: book(0.47, 0.55) });
    expect(o.followerPrice).toBe(0.47);
    expect(o.slippageCents).toBeCloseTo(3, 6);
    expect(o.improved).toBe(false);
  });

  it("marks improved follower execution with negative slippage", () => {
    const buy = computeObservation({ side: "BUY", leaderPrice: 0.6, requiredShares: null, sample: book(0.5, 0.55) });
    expect(buy.slippageCents).toBeCloseTo(-5, 6);
    expect(buy.improved).toBe(true);
    const sell = computeObservation({ side: "SELL", leaderPrice: 0.4, requiredShares: null, sample: book(0.45, 0.5) });
    expect(sell.improved).toBe(true);
  });

  it("computes 30-second and 60-second delayed price math the same deterministic way", () => {
    const at30 = computeObservation({ side: "BUY", leaderPrice: 0.4, requiredShares: null, sample: book(0.4, 0.42) });
    const at60 = computeObservation({ side: "BUY", leaderPrice: 0.4, requiredShares: null, sample: book(0.4, 0.45) });
    expect(at30.slippageCents).toBeCloseTo(2, 6);
    expect(at30.slippagePct).toBeCloseTo(5, 4);
    expect(at60.slippageCents).toBeCloseTo(5, 6);
    expect(at60.slippagePct).toBeCloseTo(12.5, 4);
  });

  it("computes spread and midpoint only when both sides are visible", () => {
    expect(spreadCents(book(0.4, 0.45))).toBeCloseTo(5, 6);
    expect(spreadCents(book(null, 0.45))).toBeNull();
    expect(midpointOf(book(0.4, 0.5))).toBeCloseTo(0.45, 6);
    expect(midpointOf(book(0.4, null))).toBeNull();
  });

  it("decides fillability deterministically from visible depth", () => {
    expect(
      computeObservation({ side: "BUY", leaderPrice: 0.5, requiredShares: 20, sample: book(0.49, 0.5, 20) }).fillable,
    ).toBe(true);
    expect(
      computeObservation({ side: "BUY", leaderPrice: 0.5, requiredShares: 21, sample: book(0.49, 0.5, 20) }).fillable,
    ).toBe(false);
    expect(
      computeObservation({ side: "SELL", leaderPrice: 0.5, requiredShares: 5, sample: book(0.49, 0.5, null) }).fillable,
    ).toBeNull();
  });
});

const obs = (
  eventKey: string,
  sampleDelay: SampleDelay,
  slippagePct: number | null,
  spread: number | null = 1,
  fillable: boolean | null = true,
): ObservationLite => ({ eventKey, sampleDelay, slippagePct, spread, fillable });

describe("copyability score", () => {
  it("returns INSUFFICIENT_DATA instead of a fake number", () => {
    const s = copyabilityScore({ observations: [obs("a", "immediate", 1)], scheduledEvents: 1 });
    expect(s.status).toBe("INSUFFICIENT_DATA");
    expect(s.score).toBeNull();
    expect(s.reason).toContain("INSUFFICIENT_DATA");
  });

  it("does not treat missing observations as zero slippage", () => {
    const s = copyabilityScore({
      observations: [obs("a", "immediate", null, null, null), obs("b", "immediate", null, null, null)],
      scheduledEvents: 2,
    });
    expect(s.medianSlippagePctByDelay.immediate).toBeNull();
    expect(s.components.slippage).toBeNull();
    expect(s.status).toBe("INSUFFICIENT_DATA");
  });

  it("scores from real evidence and reports completeness", () => {
    const observations = ["a", "b", "c"].flatMap((k) => [
      obs(k, "immediate", 1),
      obs(k, "30s", 1),
      obs(k, "60s", 1),
      obs(k, "5m", 1),
      obs(k, "15m", 1),
    ]);
    const s = copyabilityScore({ observations, scheduledEvents: 3 });
    expect(s.status).toBe("SCORED");
    expect(s.completeness).toBe(1);
    expect(s.eventsWithUsableObservation).toBe(3);
    expect(s.components.slippage).toBe(90);
    expect(s.components.spread).toBe(90);
    expect(s.components.fillability).toBe(100);
    expect(s.score).toBe(93);
  });

  it("keeps experiments isolated: observations of one wallet cannot move another score", () => {
    const a = ["a1", "a2", "a3"].flatMap((k) => [obs(k, "immediate", 0), obs(k, "30s", 0), obs(k, "60s", 0)]);
    const b = ["b1", "b2", "b3"].flatMap((k) => [obs(k, "immediate", 8), obs(k, "30s", 8), obs(k, "60s", 8)]);
    const scoreA = copyabilityScore({ observations: a, scheduledEvents: 3 });
    const scoreB = copyabilityScore({ observations: b, scheduledEvents: 3 });
    expect(scoreA.score).not.toBe(scoreB.score);
    expect(copyabilityScore({ observations: a, scheduledEvents: 3 }).score).toBe(scoreA.score);
  });
});