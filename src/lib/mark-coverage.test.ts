import { describe, expect, it } from "vitest";

import { MARK_MAX_AGE_MS, resolveMark } from "./shadow-core";

const now = 1_800_000_000_000;

describe("resolveMark one-sided books", () => {
  it("marks a two-sided book at the mid", () => {
    const r = resolveMark({ bestBid: 0.4, bestAsk: 0.6, midpoint: null, markTs: now, nowMs: now });
    expect(r).toEqual({ mark: 0.5, source: "clob_book_mid", fresh: true });
  });

  it("marks a bid-only book at the executable best bid", () => {
    const r = resolveMark({ bestBid: 0.37, bestAsk: null, midpoint: null, markTs: now, nowMs: now });
    expect(r).toEqual({ mark: 0.37, source: "clob_best_bid", fresh: true });
  });

  it("leaves an ask-only book unavailable (no exit liquidity)", () => {
    const r = resolveMark({ bestBid: null, bestAsk: 0.62, midpoint: null, markTs: now, nowMs: now });
    expect(r.mark).toBeNull();
  });

  it("never marks from a stale observation", () => {
    const r = resolveMark({
      bestBid: 0.4,
      bestAsk: null,
      midpoint: null,
      markTs: now - MARK_MAX_AGE_MS - 1,
      nowMs: now,
    });
    expect(r.mark).toBeNull();
  });
});
