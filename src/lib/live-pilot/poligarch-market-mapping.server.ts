import { resolveCompatibility, type CompatibilityResult, type SourceMarket } from "../pmus/compatibility.server";

export type PoligarchSourceEvent = {
  conditionId: string | null;
  asset: string;
  marketTitle: string;
  outcome: string | null;
  side: "BUY" | "SELL";
  price: number;
  sourceTs: number;
};

export type MarketMappingResult = {
  status: "MAPPED" | "SKIP";
  usMarketSlug: string | null;
  reason: string;
  skipReason?: "LIVE_MARKET_MAPPING_UNVERIFIED";
};

type ResolveCompatibilityFn = (source: SourceMarket | null) => Promise<CompatibilityResult>;

/**
 * Market identity must be exact. Only EXACT_MATCH ever becomes tradeable;
 * every other compatibility outcome fails closed to SKIP with an explicit
 * reason, never a substituted "similar" market.
 */
export async function mapPoligarchSourceEvent(
  event: PoligarchSourceEvent,
  resolve: ResolveCompatibilityFn = resolveCompatibility,
): Promise<MarketMappingResult> {
  const source: SourceMarket = {
    question: event.marketTitle,
    ...(event.outcome ? { outcomes: [event.outcome] } : {}),
  };

  const result = await resolve(source);

  if (result.compatibility === "EXACT_MATCH") {
    return { status: "MAPPED", usMarketSlug: result.usMarketSlug, reason: result.reason };
  }

  return {
    status: "SKIP",
    usMarketSlug: null,
    reason: result.reason,
    skipReason: "LIVE_MARKET_MAPPING_UNVERIFIED",
  };
}
