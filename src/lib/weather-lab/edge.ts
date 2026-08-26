/**
 * Net edge calculation and the paper-entry gate.
 *
 * This is the module that answers the only question the lab exists to answer:
 *
 *   does our estimated true probability beat the actual executable US market
 *   price after all costs?
 *
 *   NET_EDGE = MODEL_PROBABILITY
 *            - EXECUTABLE_PRICE
 *            - FEES
 *            - SLIPPAGE_BUFFER
 *
 * Everything is expressed in probability points (equivalently dollars per
 * contract on a $1 payout) so the terms are directly comparable.
 *
 * The threshold lives in the frozen experiment config, never here. Nothing in
 * this file may be tuned against observed forward results.
 */

import { quoteFee, type FeeSchedule } from "./fees";
import type { AdverseScenario, FillResult } from "./execution";

export type StrategyClass =
  | "CHEAP_TAIL_VALUE"
  | "MID_PRICE_VALUE"
  | "HIGH_CONFIDENCE_VALUE"
  | "INTRADAY_OBSERVATION_EDGE"
  | "MODEL_DISAGREEMENT"
  | "FORECAST_REVISION";

export type EdgeInputs = {
  modelProbability: number;
  /** The price we would actually pay, from walked depth, not the displayed BBO. */
  executablePriceUsd: number;
  contracts: number;
  schedule: FeeSchedule;
  /** Extra buffer in probability points for latency and quote movement. */
  slippageBufferUsd: number;
  /** Best bid / best ask at decision time, for reporting spread cost. */
  bestBidUsd?: number | null;
  bestAskUsd?: number | null;
};

export type EdgeResult = {
  modelProbability: number;
  executablePriceUsd: number;
  /** Model probability minus executable price, before costs. */
  rawEdge: number;
  feePerContractUsd: number;
  slippageBufferUsd: number;
  /** The number the gate is applied to. */
  netEdge: number;
  spreadUsd: number | null;
  /** Expected value per contract in dollars, on a $1 payout. */
  expectedValuePerContractUsd: number;
};

export type EntryDecision = {
  decision: "ENTER" | "REJECT";
  reasons: string[];
  edge: EdgeResult;
  strategyClass: StrategyClass | null;
};

/**
 * Frozen per experiment. Any change requires a new experiment id, because a
 * threshold moved after seeing results is not a threshold.
 */
export type EntryGate = {
  /** Minimum net edge in probability points. */
  minNetEdge: number;
  /** Reject anything priced above this. */
  maxPriceUsd: number;
  /** Reject anything priced below this. */
  minPriceUsd: number;
  /** Minimum distribution confidence. */
  minConfidence: number;
  /** Maximum tolerated model disagreement, degrees F. */
  maxModelDispersionF: number;
  /** Strategy classes enabled for this experiment. */
  enabledStrategyClasses: readonly StrategyClass[];
  /** Settlement must be verified before any paper entry. */
  requireVerifiedSettlement: true;
};

export function computeEdge(inputs: EdgeInputs): EdgeResult {
  const {
    modelProbability,
    executablePriceUsd,
    contracts,
    schedule,
    slippageBufferUsd,
    bestBidUsd = null,
    bestAskUsd = null,
  } = inputs;

  if (!Number.isFinite(modelProbability) || modelProbability < 0 || modelProbability > 1) {
    throw new RangeError(`modelProbability must be within [0,1], got ${modelProbability}`);
  }
  if (!Number.isFinite(executablePriceUsd) || executablePriceUsd < 0 || executablePriceUsd > 1) {
    throw new RangeError(`executablePriceUsd must be within [0,1], got ${executablePriceUsd}`);
  }
  if (!Number.isFinite(slippageBufferUsd) || slippageBufferUsd < 0) {
    throw new RangeError(`slippageBufferUsd must be non-negative, got ${slippageBufferUsd}`);
  }

  const feePerContractUsd = quoteFee({
    price: executablePriceUsd,
    contracts,
    schedule,
  }).feePerContractUsd;

  const rawEdge = modelProbability - executablePriceUsd;
  const netEdge = rawEdge - feePerContractUsd - slippageBufferUsd;
  const spreadUsd = bestBidUsd !== null && bestAskUsd !== null ? bestAskUsd - bestBidUsd : null;

  return {
    modelProbability,
    executablePriceUsd,
    rawEdge,
    feePerContractUsd,
    slippageBufferUsd,
    netEdge,
    spreadUsd,
    expectedValuePerContractUsd: netEdge,
  };
}

/** Classify a candidate. Returns null when no enabled class matches. */
export function classifyStrategy(params: {
  executablePriceUsd: number;
  observationFloorApplied: boolean;
  modelDispersionF: number;
  enabled: readonly StrategyClass[];
}): StrategyClass | null {
  const { executablePriceUsd, observationFloorApplied, modelDispersionF, enabled } = params;
  const candidates: StrategyClass[] = [];

  if (observationFloorApplied) candidates.push("INTRADAY_OBSERVATION_EDGE");
  if (modelDispersionF >= 3) candidates.push("MODEL_DISAGREEMENT");
  if (executablePriceUsd <= 0.2) candidates.push("CHEAP_TAIL_VALUE");
  else if (executablePriceUsd < 0.55) candidates.push("MID_PRICE_VALUE");
  else candidates.push("HIGH_CONFIDENCE_VALUE");

  return candidates.find((c) => enabled.includes(c)) ?? null;
}

/**
 * Apply the frozen gate. Collects every failing reason rather than
 * short-circuiting, so the dashboard can show why a candidate was rejected.
 */
export function decideEntry(params: {
  inputs: EdgeInputs;
  gate: EntryGate;
  confidence: number;
  modelDispersionF: number;
  settlementVerified: boolean;
  observationFloorApplied: boolean;
  fill: FillResult;
}): EntryDecision {
  const { inputs, gate, confidence, modelDispersionF, settlementVerified, observationFloorApplied, fill } = params;
  const edge = computeEdge(inputs);
  const reasons: string[] = [];

  if (!settlementVerified) reasons.push("SETTLEMENT_UNVERIFIED");
  if (fill.status !== "FILLED") reasons.push(`NOT_FILLABLE:${fill.status}${fill.reason ? `:${fill.reason}` : ""}`);
  if (edge.netEdge < gate.minNetEdge) reasons.push("NET_EDGE_BELOW_THRESHOLD");
  if (inputs.executablePriceUsd > gate.maxPriceUsd) reasons.push("PRICE_ABOVE_MAX");
  if (inputs.executablePriceUsd < gate.minPriceUsd) reasons.push("PRICE_BELOW_MIN");
  if (confidence < gate.minConfidence) reasons.push("CONFIDENCE_BELOW_THRESHOLD");
  if (modelDispersionF > gate.maxModelDispersionF) reasons.push("MODEL_DISPERSION_ABOVE_MAX");

  const strategyClass = classifyStrategy({
    executablePriceUsd: inputs.executablePriceUsd,
    observationFloorApplied,
    modelDispersionF,
    enabled: gate.enabledStrategyClasses,
  });
  if (strategyClass === null) reasons.push("NO_ENABLED_STRATEGY_CLASS");

  return { decision: reasons.length === 0 ? "ENTER" : "REJECT", reasons, edge, strategyClass };
}

/** Net edge under every adverse fill scenario, for the stress panel. */
export function edgeUnderScenarios(params: {
  modelProbability: number;
  fills: Record<AdverseScenario, FillResult>;
  schedule: FeeSchedule;
  slippageBufferUsd: number;
}): Array<{ scenario: AdverseScenario; netEdge: number | null; fillStatus: FillResult["status"] }> {
  const { modelProbability, fills, schedule, slippageBufferUsd } = params;
  return (Object.keys(fills) as AdverseScenario[]).map((scenario) => {
    const fill = fills[scenario];
    if (fill.averagePriceUsd === null || fill.filledContracts <= 0) {
      return { scenario, netEdge: null, fillStatus: fill.status };
    }
    const edge = computeEdge({
      modelProbability,
      executablePriceUsd: fill.averagePriceUsd,
      contracts: fill.filledContracts,
      schedule,
      slippageBufferUsd,
    });
    return { scenario, netEdge: edge.netEdge, fillStatus: fill.status };
  });
}
