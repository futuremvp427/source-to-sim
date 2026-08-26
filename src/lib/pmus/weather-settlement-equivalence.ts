/**
 * Historical settlement-source comparison for weather translation research.
 *
 * International weather contracts and Polymarket US weather contracts can
 * reference the same airport while still resolve from different upstream data
 * products. This module therefore treats historical agreement as evidence only.
 * It can never promote a translated contract into production EXACT_MATCH.
 */

export type WeatherStation = "KLAX" | "KSFO" | "KMIA";

export type WeatherBucket =
  | { kind: "range"; lowF: number; highF: number }
  | { kind: "at_or_below"; valueF: number }
  | { kind: "at_or_above"; valueF: number };

export type HistoricalSettlementObservation = {
  id: string;
  station: WeatherStation;
  date: string;
  contract: WeatherBucket;
  /** Resolved result on the international/source contract. */
  sourceResolvedYes: boolean;
  /** Official NWS CLI daily maximum used for the US-style counterfactual. */
  nwsHighF: number;
};

export type WeatherSettlementEquivalenceStatus =
  | "DIVERGENCE_OBSERVED"
  | "INSUFFICIENT_DATA"
  | "NO_DIVERGENCE_OBSERVED";

export type HistoricalSettlementComparison = {
  status: WeatherSettlementEquivalenceStatus;
  independentObservations: number;
  observationRows: number;
  duplicateObservations: number;
  agreements: number;
  divergences: number;
  agreementRate: number | null;
  /** Hard invariant: historical translation evidence never unlocks EXACT_MATCH. */
  exactMatchEligible: false;
  /**
   * This only says a sufficiently large replay had no observed divergence.
   * It remains research/paper evidence and is not execution eligibility.
   */
  paperResearchPromotionEligible: boolean;
};

function assertFinite(value: number, label: string): void {
  if (!Number.isFinite(value)) throw new Error(`${label} must be finite`);
}

function validateBucket(contract: WeatherBucket): void {
  if (contract.kind === "range") {
    assertFinite(contract.lowF, "range lowF");
    assertFinite(contract.highF, "range highF");
    if (contract.lowF > contract.highF) throw new Error("range lowF must be <= highF");
    return;
  }

  assertFinite(contract.valueF, `${contract.kind} valueF`);
}

export function wouldResolveYes(contract: WeatherBucket, highF: number): boolean {
  validateBucket(contract);
  assertFinite(highF, "nwsHighF");

  if (contract.kind === "range") {
    return highF >= contract.lowF && highF <= contract.highF;
  }
  if (contract.kind === "at_or_below") return highF <= contract.valueF;
  return highF >= contract.valueF;
}

function stationDayKey(observation: HistoricalSettlementObservation): string {
  return `${observation.station}|${observation.date}`;
}

/**
 * Collapse repeated buckets from one station/day into one independent weather
 * observation so multiple contracts on the same daily high cannot inflate the
 * sample size. A station/day is divergent if any audited bucket disagrees.
 */
export function evaluateHistoricalSettlementEquivalence(
  observations: readonly HistoricalSettlementObservation[],
  minIndependentObservations = 30,
): HistoricalSettlementComparison {
  if (!Number.isInteger(minIndependentObservations) || minIndependentObservations <= 0) {
    throw new Error("minIndependentObservations must be a positive integer");
  }

  const stationDays = new Map<string, boolean>();

  for (const observation of observations) {
    if (!observation.id.trim()) throw new Error("observation id is required");
    if (!/^\d{4}-\d{2}-\d{2}$/.test(observation.date)) {
      throw new Error(`invalid observation date: ${observation.date}`);
    }

    const targetResolvedYes = wouldResolveYes(observation.contract, observation.nwsHighF);
    const agrees = targetResolvedYes === observation.sourceResolvedYes;
    const key = stationDayKey(observation);
    const prior = stationDays.get(key);
    stationDays.set(key, prior === undefined ? agrees : prior && agrees);
  }

  const independentObservations = stationDays.size;
  const divergences = [...stationDays.values()].filter((agrees) => !agrees).length;
  const agreements = independentObservations - divergences;
  const agreementRate = independentObservations === 0 ? null : agreements / independentObservations;

  let status: WeatherSettlementEquivalenceStatus;
  if (divergences > 0) status = "DIVERGENCE_OBSERVED";
  else if (independentObservations < minIndependentObservations) status = "INSUFFICIENT_DATA";
  else status = "NO_DIVERGENCE_OBSERVED";

  return {
    status,
    independentObservations,
    observationRows: observations.length,
    duplicateObservations: observations.length - independentObservations,
    agreements,
    divergences,
    agreementRate,
    exactMatchEligible: false,
    paperResearchPromotionEligible: status === "NO_DIVERGENCE_OBSERVED",
  };
}

export type SamePriceBuyHold = {
  shares: number;
  price: number;
  resolvedYes: boolean;
};

/**
 * Research-only same-entry-price BUY/hold counterfactual.
 *
 * This intentionally does not claim a historical PM-US executable fill. It is
 * useful only when the historical target-venue BBO/quote is unavailable.
 */
export function samePriceBuyHoldPnl(input: SamePriceBuyHold): number {
  assertFinite(input.shares, "shares");
  assertFinite(input.price, "price");
  if (input.shares < 0) throw new Error("shares must be >= 0");
  if (input.price < 0 || input.price > 1) throw new Error("price must be between 0 and 1");

  return input.resolvedYes
    ? input.shares * (1 - input.price)
    : -input.shares * input.price;
}
