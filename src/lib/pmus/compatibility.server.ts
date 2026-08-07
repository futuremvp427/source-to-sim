/**
 * Conservative market compatibility gate.
 *
 * International Polymarket market identifiers do NOT map to Polymarket US
 * markets. Only an EXACT_MATCH on an active, open Polymarket US market may
 * produce an authenticated order preview. EXACT_MATCH requires strong
 * evidence: agreeing date, location, contract semantics (including
 * temperature threshold/range and units) and substantive title overlap.
 * Generic YES/NO outcomes are never evidence.
 */

import { safeErrorMessage } from "./redact";
import { searchUsMarkets, type MarketSearchQuery, type UsMarket } from "./us-markets.server";

export type { UsMarket } from "./us-markets.server";

export type Compatibility = "EXACT_MATCH" | "POSSIBLE_MATCH" | "AMBIGUOUS" | "NO_MATCH";

export type CompatibilityResult = {
  compatibility: Compatibility;
  usMarketSlug: string | null;
  reason: string;
};

export type SourceMarket = {
  question?: string | null;
  slug?: string | null;
  location?: string | null;
  date?: string | null;
  endDate?: string | null;
  outcomes?: readonly string[];
  category?: string | null;
};

export type MarketLookup = (query: MarketSearchQuery) => Promise<UsMarket[]>;

/** Public candidate lookup. No credentials involved. */
export const lookupUsMarkets: MarketLookup = (query) => searchUsMarkets(query);

/* ------------------------------ Normalization ------------------------------ */

const GENERIC_TOKENS = new Set([
  "will",
  "the",
  "a",
  "an",
  "be",
  "is",
  "are",
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
  "than",
  "this",
  "that",
  "it",
  "resolve",
  "resolved",
]);

export function contentTokens(text: string | null | undefined): Set<string> {
  const tokens = (text ?? "")
    .toLowerCase()
    .replace(/[-_/]/g, " ")
    .match(/[a-z]{2,}|\d+(?:\.\d+)?/g);
  return new Set((tokens ?? []).filter((t) => !GENERIC_TOKENS.has(t)));
}

export function titleSimilarity(a: string | null | undefined, b: string | null | undefined): number {
  const left = contentTokens(a);
  const right = contentTokens(b);
  if (left.size === 0 || right.size === 0) return 0;
  let shared = 0;
  for (const token of left) if (right.has(token)) shared += 1;
  const union = new Set([...left, ...right]).size;
  return union === 0 ? 0 : shared / union;
}

export type Threshold =
  | { kind: "range"; low: number; high: number; unit: string | null }
  | { kind: "above" | "below" | "exact"; value: number; unit: string | null };

const MONTHS: Record<string, string> = {
  jan: "01",
  feb: "02",
  mar: "03",
  apr: "04",
  may: "05",
  jun: "06",
  jul: "07",
  aug: "08",
  sep: "09",
  oct: "10",
  nov: "11",
  dec: "12",
};

/** Extracts an ISO date (YYYY-MM-DD) from text/slug/endDate, when present. */
export function extractDate(source: {
  question?: string | null | undefined;
  slug?: string | null | undefined;
  date?: string | null | undefined;
  endDate?: string | null | undefined;
}): string | null {
  if (source.date && /^\d{4}-\d{2}-\d{2}/.test(source.date)) return source.date.slice(0, 10);

  const haystack = `${source.question ?? ""} ${source.slug ?? ""}`;
  const iso = haystack.match(/(\d{4})-(\d{2})-(\d{2})/);
  if (iso) return `${iso[1]}-${iso[2]}-${iso[3]}`;

  const named = haystack
    .toLowerCase()
    .match(/\b(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?\s+(\d{1,2})\b/);
  if (named) {
    const month = MONTHS[named[1] as string];
    const day = String(Number(named[2])).padStart(2, "0");
    const year = source.endDate?.slice(0, 4) ?? new Date().getUTCFullYear().toString();
    if (month) return `${year}-${month}-${day}`;
  }

  if (source.endDate && /^\d{4}-\d{2}-\d{2}/.test(source.endDate)) return source.endDate.slice(0, 10);
  return null;
}

function normalizeUnit(raw: string | undefined): string | null {
  if (!raw) return null;
  const unit = raw.toLowerCase().replace(/[^a-z]/g, "");
  if (unit.startsWith("f")) return "F";
  if (unit.startsWith("c")) return "C";
  if (unit.includes("inch") || unit === "in") return "IN";
  return unit.toUpperCase() || null;
}

/** Extracts a temperature/numeric threshold or range from a market question. */
export function extractThreshold(text: string | null | undefined): Threshold | null {
  const raw = (text ?? "").toLowerCase().replace(/\s+/g, " ");
  if (!raw) return null;

  const range = raw.match(/(-?\d+(?:\.\d+)?)\s*(?:-|to|–)\s*(-?\d+(?:\.\d+)?)\s*(?:°\s*)?(f|c)?\b/);
  if (range) {
    return {
      kind: "range",
      low: Number(range[1]),
      high: Number(range[2]),
      unit: normalizeUnit(range[3]),
    };
  }

  const above = raw.match(
    /(?:exceed|exceeds|above|over|greater than|more than|at least|>=|>)\s*(-?\d+(?:\.\d+)?)\s*(?:°\s*)?(f|c)?\b/,
  );
  if (above) {
    return { kind: "above", value: Number(above[1]), unit: normalizeUnit(above[2]) };
  }

  const below = raw.match(
    /(?:below|under|less than|fewer than|at most|<=|<)\s*(-?\d+(?:\.\d+)?)\s*(?:°\s*)?(f|c)?\b/,
  );
  if (below) {
    return { kind: "below", value: Number(below[1]), unit: normalizeUnit(below[2]) };
  }

  const exact = raw.match(/(-?\d+(?:\.\d+)?)\s*(?:°\s*(f|c)|degrees?\s*(f|c)?)\b/);
  if (exact) {
    return {
      kind: "exact",
      value: Number(exact[1]),
      unit: normalizeUnit(exact[2] ?? exact[3]),
    };
  }

  return null;
}

export type ThresholdAgreement = "AGREE" | "CONFLICT" | "UNKNOWN";

export function compareThresholds(
  a: Threshold | null,
  b: Threshold | null,
): ThresholdAgreement {
  if (!a && !b) return "UNKNOWN";
  if (!a || !b) return "CONFLICT";
  if (a.kind !== b.kind) return "CONFLICT";
  if (a.unit && b.unit && a.unit !== b.unit) return "CONFLICT";
  if (a.kind === "range" && b.kind === "range") {
    return a.low === b.low && a.high === b.high ? "AGREE" : "CONFLICT";
  }
  if (a.kind !== "range" && b.kind !== "range") {
    return a.value === b.value ? "AGREE" : "CONFLICT";
  }
  return "CONFLICT";
}

const US_LOCATIONS = [
  "new york",
  "nyc",
  "los angeles",
  "chicago",
  "houston",
  "phoenix",
  "philadelphia",
  "san antonio",
  "san diego",
  "dallas",
  "austin",
  "denver",
  "seattle",
  "boston",
  "miami",
  "atlanta",
  "detroit",
  "minneapolis",
  "las vegas",
  "portland",
  "washington",
  "london",
  "moscow",
  "paris",
  "tokyo",
  "seoul",
];

export function extractLocation(text: string | null | undefined): string | null {
  const raw = (text ?? "").toLowerCase().replace(/[-_]/g, " ");
  for (const location of US_LOCATIONS) {
    if (raw.includes(location)) return location === "nyc" ? "new york" : location;
  }
  return null;
}

/* -------------------------------- Classifier -------------------------------- */

const STRONG_TITLE_SIMILARITY = 0.6;
const WEAK_TITLE_SIMILARITY = 0.3;

type Evidence = {
  market: UsMarket;
  strong: boolean;
  weak: boolean;
  similarity: number;
  notes: string;
};

function isTradable(market: UsMarket): boolean {
  return market.active === true && market.closed !== true && market.archived !== true;
}

function evaluate(source: SourceMarket, market: UsMarket): Evidence {
  const similarity = titleSimilarity(source.question, market.question);
  const sameSlug = Boolean(source.slug && market.slug && source.slug === market.slug);

  const sourceDate = extractDate(source);
  const marketDate = extractDate({
    question: market.question,
    slug: market.slug,
    endDate: market.endDate,
  });
  const dateConflict = Boolean(sourceDate && marketDate && sourceDate !== marketDate);
  const dateAgrees = Boolean(sourceDate && marketDate && sourceDate === marketDate);

  const sourceLocation = source.location ?? extractLocation(source.question ?? source.slug);
  const marketLocation = extractLocation(market.question ?? market.slug);
  const locationConflict = Boolean(
    sourceLocation && marketLocation && sourceLocation !== marketLocation,
  );
  const locationAgrees = Boolean(
    sourceLocation && marketLocation && sourceLocation === marketLocation,
  );

  const thresholdAgreement = compareThresholds(
    extractThreshold(source.question),
    extractThreshold(market.question),
  );

  if (dateConflict) {
    return { market, strong: false, weak: false, similarity, notes: "date differs" };
  }
  if (locationConflict) {
    return { market, strong: false, weak: false, similarity, notes: "location differs" };
  }
  if (thresholdAgreement === "CONFLICT") {
    return {
      market,
      strong: false,
      weak: false,
      similarity,
      notes: "threshold/range or units differ",
    };
  }

  const strong =
    isTradable(market) &&
    (sameSlug ||
      (dateAgrees &&
        !locationConflict &&
        similarity >= STRONG_TITLE_SIMILARITY &&
        (thresholdAgreement === "AGREE" || extractThreshold(source.question) === null)));

  const weak = !strong && (similarity >= WEAK_TITLE_SIMILARITY || (dateAgrees && locationAgrees));

  return {
    market,
    strong,
    weak,
    similarity,
    notes: strong ? "strong evidence" : weak ? "partial overlap only" : "insufficient overlap",
  };
}

/** Pure classifier — no I/O, fully testable. */
export function classifyCompatibility(
  source: SourceMarket | null,
  candidates: readonly UsMarket[],
): CompatibilityResult {
  if (!source || (!source.question && !source.slug)) {
    return {
      compatibility: "NO_MATCH",
      usMarketSlug: null,
      reason: "Source market has no identifying question or slug.",
    };
  }

  if (candidates.length === 0) {
    return {
      compatibility: "NO_MATCH",
      usMarketSlug: null,
      reason: "No Polymarket US market candidates were found for this source market.",
    };
  }

  const evidence = candidates.map((market) => evaluate(source, market));
  const strong = evidence.filter((e) => e.strong);

  if (strong.length > 1) {
    return {
      compatibility: "AMBIGUOUS",
      usMarketSlug: null,
      reason: `${strong.length} Polymarket US markets match this source market equally strongly.`,
    };
  }

  if (strong.length === 1) {
    const best = strong[0] as Evidence;
    return {
      compatibility: "EXACT_MATCH",
      usMarketSlug: best.market.slug ?? null,
      reason:
        `Active Polymarket US market ${best.market.slug} matches on date, location and contract ` +
        `semantics (title similarity ${best.similarity.toFixed(2)}).`,
    };
  }

  const weak = evidence.filter((e) => e.weak);
  if (weak.length > 1) {
    const top = Math.max(...weak.map((e) => e.similarity));
    const tied = weak.filter((e) => Math.abs(e.similarity - top) < 0.05);
    if (tied.length > 1) {
      return {
        compatibility: "AMBIGUOUS",
        usMarketSlug: null,
        reason: `${tied.length} Polymarket US markets overlap partially and equally; no single equivalent.`,
      };
    }
  }

  if (weak.length >= 1) {
    const best = weak.reduce((a, b) => (b.similarity > a.similarity ? b : a));
    return {
      compatibility: "POSSIBLE_MATCH",
      usMarketSlug: null,
      reason:
        `Polymarket US market ${best.market.slug} partially overlaps ` +
        `(similarity ${best.similarity.toFixed(2)}) but contract equivalence is not proven.`,
    };
  }

  const blocked = evidence.find((e) => e.notes !== "insufficient overlap");
  return {
    compatibility: "NO_MATCH",
    usMarketSlug: null,
    reason: blocked
      ? `No equivalent Polymarket US market: closest candidate ${blocked.notes}.`
      : "No Polymarket US market is semantically equivalent to this source market.",
  };
}

export async function resolveCompatibility(
  source: SourceMarket | null,
  lookup: MarketLookup = lookupUsMarkets,
): Promise<CompatibilityResult> {
  if (!source || (!source.question && !source.slug)) return classifyCompatibility(null, []);
  try {
    const candidates = await lookup({
      question: source.question ?? null,
      slug: source.slug ?? null,
      location: source.location ?? null,
      date: source.date ?? null,
      outcomes: source.outcomes,
      category: source.category ?? null,
    });
    return classifyCompatibility(source, candidates);
  } catch (err) {
    return {
      compatibility: "NO_MATCH",
      usMarketSlug: null,
      reason: safeErrorMessage(err),
    };
  }
}