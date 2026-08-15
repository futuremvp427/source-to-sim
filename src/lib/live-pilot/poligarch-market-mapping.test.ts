import { describe, it, expect, vi } from "vitest";
import { mapPoligarchSourceEvent } from "./poligarch-market-mapping.server";
import type { CompatibilityResult } from "../pmus/compatibility.server";

const baseEvent = {
  conditionId: "0xcond",
  asset: "tok-a",
  marketTitle: "Will it snow in Chicago by Feb 1?",
  outcome: "YES",
  side: "BUY" as const,
  price: 0.42,
  sourceTs: 1_700_000_000,
};

describe("mapPoligarchSourceEvent", () => {
  it("maps to MAPPED only on EXACT_MATCH", async () => {
    const resolve = vi.fn(
      async (): Promise<CompatibilityResult> => ({
        compatibility: "EXACT_MATCH",
        usMarketSlug: "chicago-snow-feb-1",
        reason: "date+location+threshold+title all matched",
      }),
    );
    const result = await mapPoligarchSourceEvent(baseEvent, resolve);
    expect(result).toEqual({
      status: "MAPPED",
      usMarketSlug: "chicago-snow-feb-1",
      reason: "date+location+threshold+title all matched",
    });
  });

  it("SKIPs with LIVE_MARKET_MAPPING_UNVERIFIED on AMBIGUOUS", async () => {
    const resolve = vi.fn(
      async (): Promise<CompatibilityResult> => ({
        compatibility: "AMBIGUOUS",
        usMarketSlug: null,
        reason: "two candidates tied on title similarity",
      }),
    );
    const result = await mapPoligarchSourceEvent(baseEvent, resolve);
    expect(result.status).toBe("SKIP");
    expect(result.skipReason).toBe("LIVE_MARKET_MAPPING_UNVERIFIED");
  });

  it("SKIPs on NO_MATCH without ever substituting a similar market", async () => {
    const resolve = vi.fn(
      async (): Promise<CompatibilityResult> => ({
        compatibility: "NO_MATCH",
        usMarketSlug: null,
        reason: "no candidate shares the source category",
      }),
    );
    const result = await mapPoligarchSourceEvent(baseEvent, resolve);
    expect(result.status).toBe("SKIP");
    expect(result.usMarketSlug).toBeNull();
  });

  it("SKIPs on POSSIBLE_MATCH (not exact enough to trade)", async () => {
    const resolve = vi.fn(
      async (): Promise<CompatibilityResult> => ({
        compatibility: "POSSIBLE_MATCH",
        usMarketSlug: "maybe-this-one",
        reason: "title similarity 0.7 but threshold differs",
      }),
    );
    const result = await mapPoligarchSourceEvent(baseEvent, resolve);
    expect(result.status).toBe("SKIP");
    expect(result.skipReason).toBe("LIVE_MARKET_MAPPING_UNVERIFIED");
  });
});
