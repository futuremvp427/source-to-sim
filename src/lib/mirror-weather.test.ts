import { describe, expect, it } from "vitest";

import { countWeather, filterTrades, isWeatherMarket, normalizeTrades } from "./mirror-trader";

const raw = [
  {
    side: "BUY",
    asset: "a1",
    conditionId: "c1",
    size: 100,
    price: 0.3,
    timestamp: 1786129596,
    title: "Will the highest temperature in Toronto be 30°C on August 8?",
    slug: "highest-temperature-in-toronto",
    outcome: "Yes",
    transactionHash: "0xabc",
  },
  {
    side: "SELL",
    asset: "a2",
    conditionId: "c2",
    size: 50,
    price: 0.6,
    timestamp: 1786129500,
    title: "Will Team X win the championship?",
    slug: "team-x-championship",
    outcome: "Yes",
    transactionHash: "0xdef",
  },
];

describe("weather heuristic", () => {
  it("classifies weather markets by title/slug keywords", () => {
    expect(isWeatherMarket(raw[0]!.title, raw[0]!.slug)).toBe(true);
    expect(isWeatherMarket(raw[1]!.title, raw[1]!.slug)).toBe(false);
  });

  it("counts weather vs other trades", () => {
    expect(countWeather(normalizeTrades(raw))).toEqual({ weather: 1, other: 1 });
  });

  it("weather-only filter never hides data when disabled", () => {
    const trades = normalizeTrades(raw);
    expect(filterTrades(trades, "", "ALL", true)).toHaveLength(1);
    expect(filterTrades(trades, "", "ALL", false)).toHaveLength(2);
  });
});
