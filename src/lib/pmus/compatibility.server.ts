/**
 * Market compatibility gate.
 *
 * International Polymarket condition IDs / token IDs do NOT map to Polymarket
 * US markets. Only an EXACT_MATCH on an active, open Polymarket US market slug
 * may produce an executable order preview.
 */

import { PMUS_BASE_URL } from "./capabilities.server";
import { safeErrorMessage } from "./redact";

export type Compatibility = "EXACT_MATCH" | "POSSIBLE_MATCH" | "AMBIGUOUS" | "NO_MATCH";

export type CompatibilityResult = {
  compatibility: Compatibility;
  usMarketSlug: string | null;
  reason: string;
};

export type UsMarket = {
  slug?: string;
  question?: string;
  active?: boolean;
  closed?: boolean;
  archived?: boolean;
};

export type MarketLookup = (slug: string) => Promise<UsMarket[]>;

/** Public markets lookup. No credentials involved. */
export const lookupUsMarketsBySlug: MarketLookup = async (slug) => {
  const url = `${PMUS_BASE_URL}/v1/markets?slug=${encodeURIComponent(slug)}&limit=10`;
  const response = await fetch(url, { headers: { Accept: "application/json" } });
  if (!response.ok) throw new Error(`Market lookup failed (HTTP ${response.status}).`);
  const json = (await response.json()) as { markets?: UsMarket[] };
  return json.markets ?? [];
};

/** Pure classifier — no I/O, fully testable. */
export function classifyCompatibility(
  sourceSlug: string | null,
  candidates: readonly UsMarket[],
): CompatibilityResult {
  if (!sourceSlug) {
    return {
      compatibility: "NO_MATCH",
      usMarketSlug: null,
      reason: "Source trade has no market slug, so no Polymarket US market can be identified.",
    };
  }

  const exact = candidates.filter((m) => m.slug === sourceSlug);
  if (exact.length > 1) {
    return {
      compatibility: "AMBIGUOUS",
      usMarketSlug: null,
      reason: "More than one Polymarket US market shares this slug.",
    };
  }

  if (exact.length === 1) {
    const market = exact[0] as UsMarket;
    const tradable = market.active === true && market.closed !== true && market.archived !== true;
    if (!tradable) {
      return {
        compatibility: "POSSIBLE_MATCH",
        usMarketSlug: null,
        reason: "Slug matches a Polymarket US market that is not currently active and open.",
      };
    }
    return {
      compatibility: "EXACT_MATCH",
      usMarketSlug: sourceSlug,
      reason: "Exact active Polymarket US market slug match.",
    };
  }

  if (candidates.length > 0) {
    return {
      compatibility: "POSSIBLE_MATCH",
      usMarketSlug: null,
      reason: "Similar Polymarket US markets exist but none match the source slug exactly.",
    };
  }

  return {
    compatibility: "NO_MATCH",
    usMarketSlug: null,
    reason: "No Polymarket US market matches this source market.",
  };
}

export async function resolveCompatibility(
  sourceSlug: string | null,
  lookup: MarketLookup = lookupUsMarketsBySlug,
): Promise<CompatibilityResult> {
  if (!sourceSlug) return classifyCompatibility(null, []);
  try {
    const candidates = await lookup(sourceSlug);
    return classifyCompatibility(sourceSlug, candidates);
  } catch (err) {
    return {
      compatibility: "NO_MATCH",
      usMarketSlug: null,
      reason: safeErrorMessage(err),
    };
  }
}