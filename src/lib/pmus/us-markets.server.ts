/**
 * Polymarket US PUBLIC market data.
 *
 * Host: https://gateway.polymarket.us (documented `servers` entry for the
 * Markets/Events OpenAPI schemas, `security: []` — no credentials).
 *
 * This module never touches credentials, never signs, and is deliberately
 * OUTSIDE the authenticated three-operation allowlist
 * (BALANCES / POSITIONS / ORDER_PREVIEW).
 */

export const PMUS_PUBLIC_BASE = "https://gateway.polymarket.us";

export type UsMarket = {
  id?: string;
  slug?: string;
  question?: string;
  description?: string;
  category?: string | null;
  subcategory?: string | null;
  marketType?: string | null;
  endDate?: string | null;
  startDate?: string | null;
  active?: boolean;
  closed?: boolean;
  archived?: boolean;
  orderPriceMinTickSize?: number;
  minimumTradeQty?: number;
  marketSides?: { description?: string | null }[];
};

export type UsMarketBbo = {
  marketSlug?: string;
  bestBid?: { value?: string } | null;
  bestAsk?: { value?: string } | null;
  currentPx?: { value?: string } | null;
};

const CATALOG_TTL_MS = 5 * 60 * 1000;
const SLUG_TTL_MS = 60 * 1000;
const CATALOG_PAGE_SIZE = 200;
const CATALOG_MAX_PAGES = 10; // bounded: at most 2,000 open markets per refresh
const REQUEST_TIMEOUT_MS = 12_000;

type CacheEntry<T> = { value: T; expiresAt: number };

let catalogCache: CacheEntry<UsMarket[]> | null = null;
let catalogInFlight: Promise<UsMarket[]> | null = null;
const slugCache = new Map<string, CacheEntry<UsMarket[]>>();

async function getJson<T>(path: string): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const response = await fetch(`${PMUS_PUBLIC_BASE}${path}`, {
      headers: { Accept: "application/json" },
      signal: controller.signal,
    });
    if (!response.ok) {
      throw new Error(`Polymarket US public market request failed (HTTP ${response.status}).`);
    }
    return (await response.json()) as T;
  } finally {
    clearTimeout(timer);
  }
}

/** GET /v1/markets?slug=... — exact slug lookup (public). */
export async function fetchUsMarketsBySlug(slug: string): Promise<UsMarket[]> {
  const cached = slugCache.get(slug);
  const now = Date.now();
  if (cached && cached.expiresAt > now) return cached.value;

  const json = await getJson<{ markets?: UsMarket[] }>(
    `/v1/markets?slug=${encodeURIComponent(slug)}&limit=10&includeHidden=false`,
  );
  const markets = json.markets ?? [];
  slugCache.set(slug, { value: markets, expiresAt: now + SLUG_TTL_MS });
  return markets;
}

/** GET /v1/markets/{slug}/bbo — public best bid/offer. */
export async function fetchUsMarketBbo(slug: string): Promise<UsMarketBbo | null> {
  const json = await getJson<{ marketData?: UsMarketBbo }>(
    `/v1/markets/${encodeURIComponent(slug)}/bbo`,
  );
  return json.marketData ?? null;
}

/** Bounded, briefly cached snapshot of currently open US markets. */
export async function fetchOpenUsMarkets(): Promise<UsMarket[]> {
  const now = Date.now();
  if (catalogCache && catalogCache.expiresAt > now) return catalogCache.value;
  if (catalogInFlight) return catalogInFlight;

  catalogInFlight = (async () => {
    const collected: UsMarket[] = [];
    for (let page = 0; page < CATALOG_MAX_PAGES; page += 1) {
      const json = await getJson<{ markets?: UsMarket[] }>(
        `/v1/markets?limit=${CATALOG_PAGE_SIZE}&offset=${page * CATALOG_PAGE_SIZE}` +
          `&active=true&closed=false&includeHidden=false`,
      );
      const markets = json.markets ?? [];
      collected.push(...markets);
      if (markets.length < CATALOG_PAGE_SIZE) break;
    }
    catalogCache = { value: collected, expiresAt: Date.now() + CATALOG_TTL_MS };
    return collected;
  })();

  try {
    return await catalogInFlight;
  } finally {
    catalogInFlight = null;
  }
}

export type MarketSearchQuery = {
  /** Source market question/title. */
  question?: string | null;
  /** Source market slug (international Polymarket). */
  slug?: string | null;
  /** Location hint (city/state), when known. */
  location?: string | null;
  /** ISO date (YYYY-MM-DD) of the event/expiration, when known. */
  date?: string | null;
  /** Outcome labels on the source market. */
  outcomes?: readonly string[];
  /** Category/type hint, e.g. "weather". */
  category?: string | null;
};

const MAX_CANDIDATES = 25;

const STOPWORDS = new Set([
  "will",
  "the",
  "a",
  "an",
  "be",
  "is",
  "in",
  "on",
  "at",
  "of",
  "to",
  "for",
  "by",
  "and",
  "or",
  "yes",
  "no",
  "market",
  "vs",
]);

export function searchTokens(query: MarketSearchQuery): string[] {
  const raw = [query.question ?? "", query.location ?? "", (query.slug ?? "").replace(/-/g, " ")]
    .join(" ")
    .toLowerCase();
  const tokens = raw.match(/[a-z]{3,}|\d{2,4}/g) ?? [];
  return [...new Set(tokens.filter((t) => !STOPWORDS.has(t)))];
}

/**
 * Public candidate search. Exact slug lookup first, then a bounded
 * token-overlap scan of the cached open-market snapshot.
 */
export async function searchUsMarkets(query: MarketSearchQuery): Promise<UsMarket[]> {
  const candidates = new Map<string, UsMarket>();

  if (query.slug) {
    for (const market of await fetchUsMarketsBySlug(query.slug)) {
      if (market.slug) candidates.set(market.slug, market);
    }
  }

  const tokens = searchTokens(query);
  if (tokens.length > 0) {
    const catalog = await fetchOpenUsMarkets();
    const scored: { market: UsMarket; score: number }[] = [];
    for (const market of catalog) {
      const haystack = `${market.question ?? ""} ${market.slug ?? ""}`.toLowerCase();
      let hits = 0;
      for (const token of tokens) if (haystack.includes(token)) hits += 1;
      if (hits > 0) scored.push({ market, score: hits / tokens.length });
    }
    scored.sort((a, b) => b.score - a.score);
    for (const { market } of scored) {
      if (candidates.size >= MAX_CANDIDATES) break;
      if (market.slug) candidates.set(market.slug, market);
    }
  }

  return [...candidates.values()].slice(0, MAX_CANDIDATES);
}

/** Test/diagnostics helper. */
export function clearUsMarketCache(): void {
  catalogCache = null;
  slugCache.clear();
}