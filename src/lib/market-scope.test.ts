import { describe, expect, it } from "vitest";

import { isCryptoMarket, isInMarketScope, parseMarketScope } from "./market-scope";

describe("CRYPTO classifier", () => {
  it("accepts representative BadTattoo-style crypto markets", () => {
    const titles = [
      "Will Ethereum dip to $3,000 in August?",
      "Ethereum above $4,500 on August 22?",
      "Will ETH reach $5,000 by September?",
      "Bitcoin above $120,000 on August 20?",
      "Will BTC dip to $100k this week?",
      "Solana above $200?",
      "Will XRP reach $5?",
      "Dogecoin above $0.30?",
    ];
    for (const t of titles) expect(isCryptoMarket(t), t).toBe(true);
  });

  it("accepts lowercase crypto slugs", () => {
    expect(isCryptoMarket("", "ethereum-above-4500-on-august-22")).toBe(true);
    expect(isCryptoMarket("", "btc-dip-to-100k")).toBe(true);
  });

  it("rejects weather, politics, generic finance and ambiguous prose", () => {
    const titles = [
      "Highest temperature in NYC on August 20?",
      "Will it rain in London tomorrow?",
      "Who will win the 2026 midterms?",
      "Will the Fed cut rates in September?",
      "Will the S&P 500 close above 6,000?",
      "Will the two sides link up before the deadline?",
      "Will Sol Campbell return to coaching?",
      "Will the coin toss be heads?",
      "Will the token gesture be enough?",
      "Will Ada Hegerberg score first?",
      "Will Linkin Park announce a tour?",
    ];
    for (const t of titles) expect(isCryptoMarket(t), t).toBe(false);
  });
});

describe("market scope eligibility", () => {
  it("ALL is always eligible", () => {
    expect(isInMarketScope("ALL", "Anything at all")).toBe(true);
    expect(isInMarketScope("ALL", "Highest temperature in NYC?")).toBe(true);
  });

  it("WEATHER reuses the existing deterministic weather classifier", () => {
    expect(isInMarketScope("WEATHER", "Highest temperature in NYC on August 20?")).toBe(true);
    expect(isInMarketScope("WEATHER", "Will ETH reach $5,000?")).toBe(false);
  });

  it("CRYPTO copies only crypto markets", () => {
    expect(isInMarketScope("CRYPTO", "Will ETH reach $5,000?")).toBe(true);
    expect(isInMarketScope("CRYPTO", "Highest temperature in NYC?")).toBe(false);
  });

  it("MENTIONS and WORLD_POLITICS fail closed until a classifier exists", () => {
    expect(isInMarketScope("MENTIONS", "Will Trump say bitcoin 5 times?")).toBe(false);
    expect(isInMarketScope("WORLD_POLITICS", "Who will win the 2026 midterms?")).toBe(false);
  });

  it("unknown/legacy scope values parse to ALL", () => {
    expect(parseMarketScope(null)).toBe("ALL");
    expect(parseMarketScope("SPORTS")).toBe("ALL");
    expect(parseMarketScope("CRYPTO")).toBe("CRYPTO");
  });
});
