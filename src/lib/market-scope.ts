/**
 * Per-experiment market scope (PAPER SIMULATION only).
 *
 * Deterministic, pure and server-safe. Scope filtering applies ONLY to
 * post-follow paper-copy eligibility: source ingestion and research history
 * stay complete. Unimplemented scopes fail closed (copy nothing) rather than
 * guessing a category.
 */

import { isWeatherMarket } from "./mirror-trader";

export const MARKET_SCOPES = ["ALL", "WEATHER", "CRYPTO", "MENTIONS", "WORLD_POLITICS"] as const;

export type MarketScope = (typeof MARKET_SCOPES)[number];

export const DEFAULT_MARKET_SCOPE: MarketScope = "ALL";

export function parseMarketScope(value: unknown): MarketScope {
  return (MARKET_SCOPES as readonly string[]).includes(String(value))
    ? (String(value) as MarketScope)
    : DEFAULT_MARKET_SCOPE;
}

/**
 * CONSERVATIVE crypto classifier. Word-boundary matching on explicit asset
 * names and unambiguous ticker symbols only. Generic words such as coin,
 * token, link or sol are never matched: a false positive would spend simulated
 * cash on an out-of-scope market, which is worse than a missed fill.
 */
const CRYPTO_NAMES = [
  "bitcoin",
  "ethereum",
  "solana",
  "dogecoin",
  "litecoin",
  "avalanche",
  "cardano",
  "ripple",
  "chainlink",
];

/** Uppercase-only tickers, matched case-sensitively to avoid prose collisions. */
const CRYPTO_TICKERS = ["BTC", "ETH", "SOL", "XRP", "DOGE", "LTC", "AVAX", "ADA", "LINK"];

function hasWord(haystackLower: string, word: string): boolean {
  return new RegExp(`(^|[^a-z0-9])${word}([^a-z0-9]|$)`).test(haystackLower);
}

function hasTicker(haystack: string, ticker: string): boolean {
  return new RegExp(`(^|[^A-Za-z0-9])${ticker}([^A-Za-z0-9]|$)`).test(haystack);
}

export function isCryptoMarket(title: string, slug?: string): boolean {
  const raw = `${title ?? ""} ${slug ?? ""}`;
  const lower = raw.toLowerCase();
  // Slug form (bitcoin-above-100k) is covered because hyphens are non-alphanumeric.
  if (CRYPTO_NAMES.some((name) => hasWord(lower, name))) return true;
  return CRYPTO_TICKERS.some((ticker) => hasTicker(raw, ticker));
}

/** True when a post-follow source fill is eligible for paper copying. */
export function isInMarketScope(scope: MarketScope, title: string, slug?: string): boolean {
  switch (scope) {
    case "ALL":
      return true;
    case "WEATHER":
      return isWeatherMarket(title ?? "", slug);
    case "CRYPTO":
      return isCryptoMarket(title ?? "", slug);
    // Fail closed until a deliberate classifier is implemented.
    case "MENTIONS":
    case "WORLD_POLITICS":
      return false;
    default:
      return false;
  }
}
