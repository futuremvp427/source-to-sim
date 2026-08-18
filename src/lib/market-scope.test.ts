import { describe, expect, it } from "vitest";

import {
  isCryptoMarket,
  isInMarketScope,
  isMentionsMarket,
  isWorldPoliticsMarket,
  parseMarketScope,
} from "./market-scope";

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

  it("rejects weather, politics, generic finance, ambiguous prose, and Mentions markets", () => {
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
      "Will Trump say bitcoin 5 times?",
    ];
    for (const t of titles) expect(isCryptoMarket(t), t).toBe(false);
  });
});

describe("MENTIONS classifier", () => {
  it("accepts explicit speech/word-use prediction markets", () => {
    const titles = [
      "Will Trump say bitcoin 5 times?",
      "Will the President mention immigration during the speech?",
      "How many times will Powell say recession during the press conference?",
      "What will the candidate mention during the debate?",
    ];
    for (const t of titles) expect(isMentionsMarket(t), t).toBe(true);
    expect(isMentionsMarket("", "will-trump-say-bitcoin-5-times")).toBe(true);
  });

  it("rejects ordinary politics, crypto, weather, finance, and prose collisions", () => {
    const titles = [
      "Who will win the 2026 midterms?",
      "Will ETH reach $5,000?",
      "Highest temperature in NYC tomorrow?",
      "Will the Fed cut rates in September?",
      "Will Linkin Park announce a tour?",
      "Will the report be released tomorrow?",
    ];
    for (const t of titles) expect(isMentionsMarket(t), t).toBe(false);
  });
});

describe("WORLD_POLITICS classifier", () => {
  it("accepts explicit election, government and geopolitical markets", () => {
    const titles = [
      "Who will win the 2026 midterms?",
      "Will the Iranian regime fall before 2027?",
      "China x Taiwan military clash before 2027?",
      "Will Republicans win the Colorado Senate race?",
      "Will the U.S. invade Iran before 2027?",
      "Will a ceasefire be reached this month?",
    ];
    for (const t of titles) expect(isWorldPoliticsMarket(t), t).toBe(true);
  });

  it("rejects Mentions, generic finance, crypto, weather, and sports collisions", () => {
    const titles = [
      "Will Trump say bitcoin 5 times?",
      "Will the Fed cut rates in September?",
      "Will the S&P 500 close above 6,000?",
      "Will ETH reach $5,000?",
      "Highest temperature in NYC tomorrow?",
      "Who will win the FIFA World Cup?",
    ];
    for (const t of titles) expect(isWorldPoliticsMarket(t), t).toBe(false);
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
    expect(isInMarketScope("CRYPTO", "Will Trump say bitcoin 5 times?")).toBe(false);
  });

  it("MENTIONS copies only explicit Mentions markets", () => {
    expect(isInMarketScope("MENTIONS", "Will Trump say bitcoin 5 times?")).toBe(true);
    expect(isInMarketScope("MENTIONS", "Who will win the 2026 midterms?")).toBe(false);
  });

  it("WORLD_POLITICS copies explicit politics/geopolitics but not Mentions", () => {
    expect(isInMarketScope("WORLD_POLITICS", "Who will win the 2026 midterms?")).toBe(true);
    expect(isInMarketScope("WORLD_POLITICS", "Will the U.S. invade Iran before 2027?")).toBe(true);
    expect(isInMarketScope("WORLD_POLITICS", "Will Trump say bitcoin 5 times?")).toBe(false);
  });

  it("unknown/legacy scope values parse to ALL", () => {
    expect(parseMarketScope(null)).toBe("ALL");
    expect(parseMarketScope("SPORTS")).toBe("ALL");
    expect(parseMarketScope("CRYPTO")).toBe("CRYPTO");
    expect(parseMarketScope("MENTIONS")).toBe("MENTIONS");
    expect(parseMarketScope("WORLD_POLITICS")).toBe("WORLD_POLITICS");
  });
});
