/**
 * Phase 0B, Part 2 infrastructure: parse a Polymarket weather market's
 * question/slug into a structured (city, date, threshold) spec so a
 * historical public forecast can be looked up for the same city/date.
 *
 * Pure, no DB/network access. FAILS CLOSED: an ambiguous or unrecognized
 * market returns null rather than guessing a city or threshold -- a wrong
 * guess here would silently corrupt the Part 2/3 baseline comparison, which
 * is worse than excluding the market from the sample.
 *
 * CAVEAT: this parser's patterns and city table were authored from a small
 * number of real captured market titles/slugs (see
 * tests/fixtures-equivalent examples in this file's tests) and general
 * knowledge of Polymarket's weather-market phrasing conventions. It has NOT
 * been validated against a live pull of the full weather-market catalog
 * (no network access in this environment -- see phase0b.server.ts's doc
 * comment). Treat unparsed/low-coverage results as a data-completeness
 * finding in its own right, not just a code defect.
 */

export type TemperatureUnit = "F" | "C";

export type ThresholdSpec =
  | { kind: "exact"; value: number; unit: TemperatureUnit }
  | { kind: "range"; low: number; high: number; unit: TemperatureUnit }
  | { kind: "exceed"; comparator: ">=" | ">" | "<=" | "<"; value: number; unit: TemperatureUnit };

export type ParsedWeatherMarket = {
  city: string;
  /** Approximate station coordinates for the public-baseline lookup. */
  lat: number;
  lon: number;
  /** ISO date (YYYY-MM-DD), UTC-naive (local civil date the market refers to). */
  date: string;
  threshold: ThresholdSpec;
};

/**
 * Known cities used in Polymarket weather markets, with approximate
 * coordinates for a public forecast API lookup. NOT exhaustive -- an
 * unrecognized city correctly returns null (fail closed) rather than a
 * wrong guess. Extend this table as real market titles are observed.
 */
export const CITY_TABLE: Readonly<
  Record<string, { lat: number; lon: number; defaultUnit: TemperatureUnit }>
> = {
  nyc: { lat: 40.7128, lon: -74.006, defaultUnit: "F" },
  "new york": { lat: 40.7128, lon: -74.006, defaultUnit: "F" },
  "new york city": { lat: 40.7128, lon: -74.006, defaultUnit: "F" },
  chicago: { lat: 41.8781, lon: -87.6298, defaultUnit: "F" },
  la: { lat: 34.0522, lon: -118.2437, defaultUnit: "F" },
  "los angeles": { lat: 34.0522, lon: -118.2437, defaultUnit: "F" },
  miami: { lat: 25.7617, lon: -80.1918, defaultUnit: "F" },
  austin: { lat: 30.2672, lon: -97.7431, defaultUnit: "F" },
  denver: { lat: 39.7392, lon: -104.9903, defaultUnit: "F" },
  phoenix: { lat: 33.4484, lon: -112.074, defaultUnit: "F" },
  houston: { lat: 29.7604, lon: -95.3698, defaultUnit: "F" },
  dallas: { lat: 32.7767, lon: -96.797, defaultUnit: "F" },
  seattle: { lat: 47.6062, lon: -122.3321, defaultUnit: "F" },
  boston: { lat: 42.3601, lon: -71.0589, defaultUnit: "F" },
  atlanta: { lat: 33.749, lon: -84.388, defaultUnit: "F" },
  philadelphia: { lat: 39.9526, lon: -75.1652, defaultUnit: "F" },
  tokyo: { lat: 35.6762, lon: 139.6503, defaultUnit: "C" },
  london: { lat: 51.5072, lon: -0.1276, defaultUnit: "C" },
  paris: { lat: 48.8566, lon: 2.3522, defaultUnit: "C" },
};

const MONTHS: Readonly<Record<string, number>> = {
  jan: 1,
  january: 1,
  feb: 2,
  february: 2,
  mar: 3,
  march: 3,
  apr: 4,
  april: 4,
  may: 5,
  jun: 6,
  june: 6,
  jul: 7,
  july: 7,
  aug: 8,
  august: 8,
  sep: 9,
  sept: 9,
  september: 9,
  oct: 10,
  october: 10,
  nov: 11,
  november: 11,
  dec: 12,
  december: 12,
};

function normalize(s: string): string {
  return (
    s
      .toLowerCase()
      .replace(/-/g, " ")
      // Separate a digit run from an immediately-following unit letter (slugs
      // often have no whitespace there, e.g. "25c", "89f") so number-matching
      // regexes below -- which rely on \b word boundaries -- see the digits as
      // their own token instead of "25c" as one unbroken word character run.
      .replace(/(\d)([a-z])/gi, "$1 $2")
      .replace(/\s+/g, " ")
      .trim()
  );
}

function findCity(
  text: string,
): { name: string; lat: number; lon: number; defaultUnit: TemperatureUnit } | null {
  // Longest match first, so "new york city" is preferred over "new york" over "nyc" ambiguity is avoided either way.
  const names = Object.keys(CITY_TABLE).sort((a, b) => b.length - a.length);
  for (const name of names) {
    const pattern = new RegExp(`\\b${name.replace(/\s+/g, "\\s+")}\\b`, "i");
    if (pattern.test(text)) {
      const entry = CITY_TABLE[name]!;
      return { name, ...entry };
    }
  }
  return null;
}

function findDate(text: string, referenceYear: number): string | null {
  // "aug 8", "august 8", "june 5 2026", "on june 5"
  const match = text.match(
    /\b(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun[e]?|jul[y]?|aug(?:ust)?|sep(?:t|tember)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\.?\s+(\d{1,2})(?:st|nd|rd|th)?(?:,?\s+(\d{4}))?\b/i,
  );
  if (!match) return null;
  const month = MONTHS[match[1]!.toLowerCase()];
  if (!month) return null;
  const day = Number.parseInt(match[2]!, 10);
  if (!(day >= 1 && day <= 31)) return null;
  const year = match[3] ? Number.parseInt(match[3], 10) : referenceYear;
  const mm = String(month).padStart(2, "0");
  const dd = String(day).padStart(2, "0");
  return `${year}-${mm}-${dd}`;
}

function findUnit(text: string, fallback: TemperatureUnit): TemperatureUnit {
  if (/\bc\b|celsius|°c/.test(text)) return "C";
  if (/\bf\b|fahrenheit|°f|degrees\b(?!\s*c)/.test(text)) return "F";
  return fallback;
}

function findThreshold(text: string, unit: TemperatureUnit): ThresholdSpec | null {
  // Range: "85-89" (already whitespace after normalize()'s hyphen removal), "85 to 89".
  // Scan every adjacent-number-pair candidate (not just the first, which
  // could be an unrelated pair like a date digit followed by the true
  // range's low end) and take the first one that is plausibly a temperature
  // range (high just above low, not e.g. a day-of-month next to a year).
  // The second number is captured via lookahead (not consumed), so
  // overlapping candidate pairs are all considered -- e.g. in "8 85 89",
  // both (8,85) and (85,89) are evaluated, not just the first non-overlapping match.
  for (const m of text.matchAll(/\b(\d{1,3})\s+(?:to\s+)?(?=(\d{1,3})\b)/g)) {
    const low = Number.parseInt(m[1]!, 10);
    const high = Number.parseInt(m[2]!, 10);
    if (high > low && high - low <= 20) {
      return { kind: "range", low, high, unit };
    }
  }

  // Exceed/threshold: "above 90", "exceed 90", "at least 90", "over 90", "below 32", "under 32"
  const exceed = text.match(/\b(above|exceed[s]?|at least|over|greater than)\s+(\d{1,3})\b/);
  if (exceed) {
    return { kind: "exceed", comparator: ">=", value: Number.parseInt(exceed[2]!, 10), unit };
  }
  const under = text.match(/\b(below|under|at most|less than)\s+(\d{1,3})\b/);
  if (under) {
    return { kind: "exceed", comparator: "<=", value: Number.parseInt(under[2]!, 10), unit };
  }

  // Exact: "be 25", "be exactly 90"
  const exact = text.match(/\bbe\s+(?:exactly\s+)?(\d{1,3})\b/);
  if (exact) {
    return { kind: "exact", value: Number.parseInt(exact[1]!, 10), unit };
  }

  // Slug-only fallback: a bare "<number> <unit-letter>" with no second
  // number following (already excluded by the range check above having
  // first claim) and no comparator word -- e.g. a structured slug ending
  // "...-25c" (normalized to "25 c") with no natural-language "be". A
  // single number directly paired with an explicit unit letter is treated
  // as the market's exact threshold; the locally-stated unit wins over the
  // city-default `unit` passed in.
  const slugExact = text.match(/\b(\d{1,3})\s+(f|c)\b/);
  if (slugExact) {
    return {
      kind: "exact",
      value: Number.parseInt(slugExact[1]!, 10),
      unit: slugExact[2] === "c" ? "C" : "F",
    };
  }

  return null;
}

/**
 * Attempts to parse city/date/threshold from a market's question and slug.
 * Both are checked (slug first, since it is typically more structured);
 * returns null if any required component (city, date, threshold) cannot be
 * confidently determined.
 */
export function parseWeatherMarket(input: {
  question: string | null | undefined;
  slug: string | null | undefined;
  referenceYear: number;
}): ParsedWeatherMarket | null {
  const slugText = normalize(input.slug ?? "");
  const questionText = normalize(input.question ?? "");
  const combined = `${slugText} ${questionText}`.trim();
  if (!combined) return null;

  const city = findCity(combined);
  if (!city) return null;

  const date = findDate(combined, input.referenceYear);
  if (!date) return null;

  const unit = findUnit(combined, city.defaultUnit);
  const threshold = findThreshold(combined, unit);
  if (!threshold) return null;

  return { city: city.name, lat: city.lat, lon: city.lon, date, threshold };
}
