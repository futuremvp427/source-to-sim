/**
 * Research-only weather signal translation gate.
 *
 * This does NOT declare an international Polymarket contract economically
 * equivalent to a Polymarket US contract. It only identifies the narrow
 * same-airport corridors that are worth historical/paper testing.
 *
 * A TRANSLATION_CANDIDATE must never bypass the existing EXACT_MATCH gate in
 * previews.server.ts / automation.ts. Settlement-source equivalence remains
 * unproven until historical agreement testing says otherwise.
 */

import {
  compareThresholds,
  extractDate,
  extractLocation,
  extractThreshold,
  type SourceMarket,
  type UsMarket,
} from "./compatibility.server";

export type WeatherTranslationStatus =
  | "TRANSLATION_CANDIDATE"
  | "NOT_TRANSLATABLE"
  | "UNVERIFIED";

export type WeatherTranslationCorridor = {
  location: "los angeles" | "san francisco" | "miami";
  station: "KLAX" | "KSFO" | "KMIA";
};

/**
 * Audited first-test corridors only.
 *
 * NYC and Chicago are intentionally absent because the international and US
 * products observed during the 2026-08 investigation use different stations.
 * No other city is admitted by inference.
 */
export const WEATHER_TRANSLATION_CORRIDORS: readonly WeatherTranslationCorridor[] =
  Object.freeze([
    { location: "los angeles", station: "KLAX" },
    { location: "san francisco", station: "KSFO" },
    { location: "miami", station: "KMIA" },
  ]);

const CORRIDOR_BY_LOCATION = new Map(
  WEATHER_TRANSLATION_CORRIDORS.map((corridor) => [corridor.location, corridor] as const),
);

export type WeatherTranslationResult = {
  status: WeatherTranslationStatus;
  station: WeatherTranslationCorridor["station"] | null;
  usMarketSlug: string | null;
  reason: string;
  /** Hard invariant: translated candidates are research/paper evidence only. */
  previewEligible: false;
  settlementEquivalence: "UNPROVEN";
};

function result(
  status: WeatherTranslationStatus,
  reason: string,
  opts: {
    station?: WeatherTranslationCorridor["station"] | null;
    usMarketSlug?: string | null;
  } = {},
): WeatherTranslationResult {
  return {
    status,
    station: opts.station ?? null,
    usMarketSlug: opts.usMarketSlug ?? null,
    reason,
    previewEligible: false,
    settlementEquivalence: "UNPROVEN",
  };
}

function tradable(market: UsMarket): boolean {
  return market.active === true && market.closed !== true && market.archived !== true;
}

/**
 * Evaluate one international weather source market against one US candidate.
 *
 * Requirements for research candidacy:
 * - both markets identify the same audited city;
 * - that city is LA, San Francisco, or Miami;
 * - both identify the same calendar date;
 * - both identify the exact same threshold/range shape, numbers, and units;
 * - the US candidate is currently tradable.
 *
 * Even when all of those pass, the result remains TRANSLATION_CANDIDATE, never
 * EXACT_MATCH, because settlement-source agreement has not been proven.
 */
export function assessWeatherTranslation(
  source: SourceMarket | null,
  market: UsMarket | null,
): WeatherTranslationResult {
  if (!source || !market) {
    return result("UNVERIFIED", "Source or US market metadata is missing.");
  }

  if (!tradable(market)) {
    return result("NOT_TRANSLATABLE", "The US market is not active and open.", {
      usMarketSlug: market.slug ?? null,
    });
  }

  const sourceLocation = source.location ?? extractLocation(source.question ?? source.slug);
  const targetLocation = extractLocation(market.question ?? market.slug);
  if (!sourceLocation || !targetLocation) {
    return result("UNVERIFIED", "Location could not be proven on both markets.", {
      usMarketSlug: market.slug ?? null,
    });
  }

  if (sourceLocation !== targetLocation) {
    return result("NOT_TRANSLATABLE", "International and US market locations differ.", {
      usMarketSlug: market.slug ?? null,
    });
  }

  const corridor = CORRIDOR_BY_LOCATION.get(sourceLocation as WeatherTranslationCorridor["location"]);
  if (!corridor) {
    return result(
      "NOT_TRANSLATABLE",
      `${sourceLocation} is not in the audited same-airport translation corridor list.`,
      { usMarketSlug: market.slug ?? null },
    );
  }

  const sourceDate = extractDate(source);
  const targetDate = extractDate({
    question: market.question,
    slug: market.slug,
    endDate: market.endDate,
  });
  if (!sourceDate || !targetDate) {
    return result("UNVERIFIED", "Calendar date could not be proven on both markets.", {
      station: corridor.station,
      usMarketSlug: market.slug ?? null,
    });
  }
  if (sourceDate !== targetDate) {
    return result("NOT_TRANSLATABLE", "International and US market dates differ.", {
      station: corridor.station,
      usMarketSlug: market.slug ?? null,
    });
  }

  const sourceThreshold = extractThreshold(source.question ?? source.slug);
  const targetThreshold = extractThreshold(market.question ?? market.slug);
  if (!sourceThreshold || !targetThreshold) {
    return result("UNVERIFIED", "Temperature bucket/threshold could not be proven on both markets.", {
      station: corridor.station,
      usMarketSlug: market.slug ?? null,
    });
  }

  if (compareThresholds(sourceThreshold, targetThreshold) !== "AGREE") {
    return result(
      "NOT_TRANSLATABLE",
      "International and US temperature bucket/threshold semantics differ.",
      { station: corridor.station, usMarketSlug: market.slug ?? null },
    );
  }

  return result(
    "TRANSLATION_CANDIDATE",
    `Same-date, same-bucket ${corridor.location} candidate at ${corridor.station}; settlement-source equivalence is still unproven, so this is research/paper-only evidence.`,
    { station: corridor.station, usMarketSlug: market.slug ?? null },
  );
}

/**
 * Return only safe research candidates. Multiple candidates are preserved so a
 * caller cannot silently pick one when the US catalog is ambiguous.
 */
export function findWeatherTranslationCandidates(
  source: SourceMarket | null,
  markets: readonly UsMarket[],
): WeatherTranslationResult[] {
  return markets
    .map((market) => assessWeatherTranslation(source, market))
    .filter((candidate) => candidate.status === "TRANSLATION_CANDIDATE");
}
