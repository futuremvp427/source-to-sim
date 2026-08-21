import { describe, expect, it } from "vitest";

import type { NormalizedEvent } from "../shadow-core";
import { isEligibleForEpisodeTrigger, toEligibleFill } from "./source-poll";

function makeEvent(overrides: Partial<NormalizedEvent> = {}): NormalizedEvent {
  return {
    eventKey: "sid:abc",
    wallet: "0xwallet",
    txHash: "0xtx",
    sourceNativeId: "abc",
    logIndex: null,
    conditionId: "0xcondition",
    asset: "0xasset",
    marketTitle: "Yankees vs Red Sox",
    outcome: "Yankees",
    slug: "yankees-vs-red-sox",
    side: "BUY",
    shares: 10,
    price: 0.55,
    sourceTs: 1_700_000_000,
    identityBasis: "source_id",
    identityDegraded: false,
    raw: { id: "abc" },
    ...overrides,
  };
}

describe("toEligibleFill", () => {
  it("maps every field 1:1 from a NormalizedEvent", () => {
    const event = makeEvent();
    const fill = toEligibleFill(event, 123456);
    expect(fill).toEqual({
      eventKey: "sid:abc",
      wallet: "0xwallet",
      conditionId: "0xcondition",
      asset: "0xasset",
      side: "BUY",
      shares: 10,
      price: 0.55,
      sourceTs: 1_700_000_000,
      detectedAt: 123456,
    });
  });

  it("returns null when conditionId is null", () => {
    expect(toEligibleFill(makeEvent({ conditionId: null }), 123456)).toBeNull();
  });

  it("passes through SELL side unchanged", () => {
    const fill = toEligibleFill(makeEvent({ side: "SELL" }), 1);
    expect(fill?.side).toBe("SELL");
  });

  it("never derives detectedAt from sourceTs", () => {
    const fill = toEligibleFill(makeEvent({ sourceTs: 1_600_000_000 }), 9_999_999_999);
    expect(fill?.detectedAt).toBe(9_999_999_999);
    expect(fill?.sourceTs).toBe(1_600_000_000);
  });

  it("preserves a degraded (tx_hash_ordinal) identity fill unchanged, since identity basis is not part of EligibleFill", () => {
    const fill = toEligibleFill(
      makeEvent({ eventKey: "ord:0xtx:asset:BUY:100:5:0.5#0", identityBasis: "tx_hash_ordinal", identityDegraded: true }),
      1,
    );
    expect(fill?.eventKey).toBe("ord:0xtx:asset:BUY:100:5:0.5#0");
  });

  it("maps fractional shares/price without rounding", () => {
    const fill = toEligibleFill(makeEvent({ shares: 12.3456, price: 0.6789 }), 1);
    expect(fill?.shares).toBe(12.3456);
    expect(fill?.price).toBe(0.6789);
  });

  it("propagates an empty-string conditionId as truthy-false (treated as missing)", () => {
    expect(toEligibleFill(makeEvent({ conditionId: "" }), 1)).toBeNull();
  });
});

describe("isEligibleForEpisodeTrigger", () => {
  const GO_LIVE_MS = 1_700_000_000_000; // matches sourceTs 1_700_000_000s exactly

  it("goLiveAtMs=null fails closed to false, even for a very recent fill", () => {
    expect(isEligibleForEpisodeTrigger(Date.now() / 1000, null)).toBe(false);
  });

  it("a non-finite goLiveAtMs fails closed to false", () => {
    expect(isEligibleForEpisodeTrigger(GO_LIVE_MS / 1000, Number.NaN)).toBe(false);
    expect(isEligibleForEpisodeTrigger(GO_LIVE_MS / 1000, Number.POSITIVE_INFINITY)).toBe(false);
  });

  it("sourceTs strictly before the boundary returns false", () => {
    expect(isEligibleForEpisodeTrigger(GO_LIVE_MS / 1000 - 1, GO_LIVE_MS)).toBe(false);
  });

  it("sourceTs exactly at the boundary returns true (inclusive)", () => {
    expect(isEligibleForEpisodeTrigger(GO_LIVE_MS / 1000, GO_LIVE_MS)).toBe(true);
  });

  it("sourceTs after the boundary returns true", () => {
    expect(isEligibleForEpisodeTrigger(GO_LIVE_MS / 1000 + 3600, GO_LIVE_MS)).toBe(true);
  });

  it("correctly converts sourceTs (seconds) to milliseconds before comparing", () => {
    // 1000 seconds = 1_000_000ms; boundary at exactly 1_000_000ms should be inclusive.
    expect(isEligibleForEpisodeTrigger(1000, 1_000_000)).toBe(true);
    expect(isEligibleForEpisodeTrigger(999, 1_000_000)).toBe(false);
  });

  it("goLiveAtMs=0 treats sourceTs=0 as at-boundary (true)", () => {
    expect(isEligibleForEpisodeTrigger(0, 0)).toBe(true);
  });

  /**
   * Task 12E / P1-F: HARD REQUIREMENT -- the same fill must produce the same answer on
   * every retry, regardless of any wallet-history/bootstrap concept. The old signature
   * took an `isBootstrap` flag that could flip between polls; the new one takes only
   * immutable/durable inputs, so there is no third argument left that COULD make the
   * answer retry-dependent. These tests prove the property directly rather than merely
   * asserting the removed parameter is gone.
   */
  it("HARD REQUIREMENT: a pre-go-live fill's answer never changes no matter how many times it's re-evaluated (simulated bootstrap, retry, and restart)", () => {
    const preGoLiveSourceTs = GO_LIVE_MS / 1000 - 1;
    // "first bootstrap poll", "later retry", and "process restart" are all just repeated
    // calls with the identical (sourceTs, goLiveAtMs) pair -- there is no isBootstrap
    // input left to vary between them.
    for (let i = 0; i < 5; i += 1) {
      expect(isEligibleForEpisodeTrigger(preGoLiveSourceTs, GO_LIVE_MS)).toBe(false);
    }
  });

  it("HARD REQUIREMENT: a post-go-live fill's answer never changes no matter how many times it's re-evaluated, including when discovered late", () => {
    const postGoLiveSourceTs = GO_LIVE_MS / 1000 + 3600;
    for (let i = 0; i < 5; i += 1) {
      expect(isEligibleForEpisodeTrigger(postGoLiveSourceTs, GO_LIVE_MS)).toBe(true);
    }
  });
});
