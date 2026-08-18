/**
 * Per-experiment market scope (PAPER SIMULATION only).
 *
 * Deterministic, pure and server-safe. Scope filtering applies ONLY to
 * post-follow paper-copy eligibility: source ingestion and research history
 * stay complete. Unknown scopes fail closed at the eligibility layer rather
 * than guessing a category.
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

function hasWord(haystackLower: string, word: string): boolean {
  return new RegExp(`(^|[^a-z0-9])${word}([^a-z0-9]|$)`).test(haystackLower);
}

function hasTicker(haystack: string, ticker: string): boolean {
  return new RegExp(`(^|[^A-Za-z0-9])${ticker}([^A-Za-z0-9]|$)`).test(haystack);
}

/**
 * Conservative Mentions classifier. A plain occurrence of a person, company,
 * crypto asset or political topic is NOT enough. The market must contain an
 * explicit speech/word-use verb plus prediction/count/speech context. This is
 * intentionally biased toward false negatives because a false positive would
 * spend simulated cash in the wrong sleeve.
 */
const MENTION_VERBS = ["say", "says", "said", "mention", "mentions", "mentioned", "utter", "utters", "uttered"];
const MENTION_CONTEXT = [
  "will",
  "what",
  "how many",
  "times",
  "during",
  "speech",
  "interview",
  "debate",
  "podcast",
  "address",
  "press conference",
  "remarks",
];

export function isMentionsMarket(title: string, slug?: string): boolean {
  const lower = `${title ?? ""} ${slug ?? ""}`.toLowerCase();
  const hasSpeechVerb = MENTION_VERBS.some((verb) => hasWord(lower, verb));
  if (!hasSpeechVerb) return false;
  return MENTION_CONTEXT.some((context) => hasWord(lower, context));
}

/**
 * CONSERVATIVE crypto classifier. Word-boundary matching on explicit asset
 * names and unambiguous ticker symbols only. Generic words such as coin,
 * token, link or sol are never matched: a false positive would spend simulated
 * cash on an out-of-scope market, which is worse than a missed fill.
 *
 * Mentions has precedence: e.g. "Will Trump say bitcoin 5 times?" is a
 * MENTIONS market, not a CRYPTO market merely because the quoted word is
 * bitcoin.
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

/**
 * Tickers safe to match case-insensitively (slugs are lowercase). "sol",
 * "link", "ada" and "ltc" are deliberately excluded here: they collide with
 * ordinary prose or other domains.
 */
const CRYPTO_TICKERS_ANY_CASE = ["btc", "eth", "xrp", "doge", "avax"];

export function isCryptoMarket(title: string, slug?: string): boolean {
  if (isMentionsMarket(title, slug)) return false;
  const raw = `${title ?? ""} ${slug ?? ""}`;
  const lower = raw.toLowerCase();
  // Slug form (bitcoin-above-100k) is covered because hyphens are non-alphanumeric.
  if (CRYPTO_NAMES.some((name) => hasWord(lower, name))) return true;
  if (CRYPTO_TICKERS_ANY_CASE.some((ticker) => hasWord(lower, ticker))) return true;
  return CRYPTO_TICKERS.some((ticker) => hasTicker(raw, ticker));
}

/**
 * Conservative World/Politics classifier. Terms are intentionally explicit:
 * elections/government institutions or geopolitical conflict/diplomacy. It
 * does not treat generic economics/finance as politics. Mentions markets take
 * precedence so a politician saying a word is not copied into both sleeves.
 */
const WORLD_POLITICS_TERMS = [
  "election",
  "elections",
  "midterm",
  "midterms",
  "presidential",
  "president",
  "prime minister",
  "parliament",
  "congress",
  "senate",
  "senator",
  "governor",
  "mayor",
  "referendum",
  "ballot",
  "nominee",
  "nomination",
  "impeach",
  "impeachment",
  "government",
  "regime",
  "coalition",
  "republican",
  "democrat",
  "democratic party",
  "labour party",
  "conservative party",
  "military clash",
  "military action",
  "invasion",
  "invade",
  "ceasefire",
  "peace deal",
  "sanctions",
  "blockade",
  "annex",
  "nato",
  "troops",
  "war",
];

/** Obvious sports contexts that can otherwise collide with words like president. */
const WORLD_POLITICS_EXCLUSIONS = [
  "world cup",
  "super bowl",
  "champions league",
  "premier league",
  "nba",
  "nfl",
  "mlb",
  "nhl",
  "ufc",
  "fifa",
];

export function isWorldPoliticsMarket(title: string, slug?: string): boolean {
  if (isMentionsMarket(title, slug)) return false;
  const lower = `${title ?? ""} ${slug ?? ""}`.toLowerCase();
  if (WORLD_POLITICS_EXCLUSIONS.some((term) => hasWord(lower, term))) return false;
  return WORLD_POLITICS_TERMS.some((term) => hasWord(lower, term));
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
    case "MENTIONS":
      return isMentionsMarket(title ?? "", slug);
    case "WORLD_POLITICS":
      return isWorldPoliticsMarket(title ?? "", slug);
    default:
      return false;
  }
}
