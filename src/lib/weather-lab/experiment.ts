/**
 * Experiment freezing, isolation, and the paper-only safety gate.
 *
 * Two invariants this module exists to make unbreakable:
 *
 * 1. **A strategy change is a new experiment.** The frozen config is hashed. If
 *    any rule, weight or threshold moves, the hash moves, and results collected
 *    under the old hash may not be blended with the new ones. This is what stops
 *    a threshold being nudged after seeing forward results.
 *
 * 2. **There is no live path.** `LIVE_EXECUTION_IMPLEMENTED` is a compile-time
 *    false. `assertPaperOnly` is called before anything that could resemble an
 *    order and throws unconditionally if a caller ever passes a non-paper mode.
 *    There is deliberately no flag, env var or argument that can flip it.
 */

import type { EntryGate, StrategyClass } from "./edge";
import { FEE_MODEL_VERSION } from "./fees";

/**
 * Hard constant. Not configurable, not environment-driven, not overridable.
 * The weather lab has no live-execution code path of any kind.
 */
export const LIVE_EXECUTION_IMPLEMENTED = false as const;

export type ExecutionMode = "PAPER";

export class LiveExecutionForbiddenError extends Error {
  constructor(context: string) {
    super(
      `Live execution is not implemented and is forbidden in the weather lab (context: ${context}). ` +
        `This system is research/paper only.`,
    );
    this.name = "LiveExecutionForbiddenError";
  }
}

/** Call before any order-shaped action. Throws unless the mode is exactly PAPER. */
export function assertPaperOnly(mode: string, context: string): asserts mode is ExecutionMode {
  if (LIVE_EXECUTION_IMPLEMENTED !== false) throw new LiveExecutionForbiddenError(context);
  if (mode !== "PAPER") throw new LiveExecutionForbiddenError(context);
}

export type ModelWeights = Record<string, number>;

/** Everything that must be frozen before forward collection begins. */
export type ExperimentConfig = {
  /** Human-readable version, e.g. "weather-intraday-v1". */
  strategyVersion: string;
  /** Cities enabled for this experiment. Each is audited individually. */
  enabledCities: readonly string[];
  /** Model blend weights by sourceId. */
  modelWeights: ModelWeights;
  gate: EntryGate;
  /** Contracts per paper entry. */
  positionSizeContracts: number;
  /** Max premium per market. */
  maxNotionalPerMarketUsd: number;
  /** Max premium across all open positions in one station-day. */
  maxNotionalPerStationDayUsd: number;
  /** Max concurrent station-days held. */
  maxConcurrentStationDays: number;
  /** Slippage buffer in probability points applied to every edge. */
  slippageBufferUsd: number;
  /** Staleness limits in milliseconds. */
  maxQuoteAgeMs: number;
  maxForecastAgeMs: number;
  /** Pinned so a venue fee change invalidates rather than silently reprices. */
  feeModelVersion: string;
  /** Settlement fingerprints admitted at freeze time, by station. */
  admittedSettlementFingerprints: Readonly<Record<string, string>>;
};

export type FrozenExperiment = {
  experimentId: string;
  configHash: string;
  frozenAt: string;
  config: ExperimentConfig;
  mode: ExecutionMode;
};

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${stableStringify(v)}`).join(",")}}`;
}

/** Deterministic config hash. Change detector, not a security primitive. */
export function hashConfig(config: ExperimentConfig): string {
  const canonical = stableStringify(config);
  let h1 = 0xdeadbeefn;
  let h2 = 0x41c6ce57n;
  const mask = 0xffffffffffffffffn;
  for (let i = 0; i < canonical.length; i++) {
    const c = BigInt(canonical.charCodeAt(i));
    h1 = ((h1 ^ c) * 0x100000001b3n) & mask;
    h2 = ((h2 + c) * 0x9e3779b97f4a7c15n) & mask;
  }
  return `wlx1-${h1.toString(16).padStart(16, "0")}${h2.toString(16).padStart(16, "0")}`;
}

export class ExperimentConfigError extends Error {
  constructor(problems: string[]) {
    super(`Experiment config is not freezable:\n- ${problems.join("\n- ")}`);
    this.name = "ExperimentConfigError";
  }
}

/** Validate and freeze. Refuses configs that could not produce sound evidence. */
export function freezeExperiment(params: {
  experimentId: string;
  config: ExperimentConfig;
  frozenAt?: Date;
}): FrozenExperiment {
  const { experimentId, config, frozenAt = new Date() } = params;
  const problems: string[] = [];

  if (!experimentId.trim()) problems.push("experimentId must be non-empty");
  if (!config.strategyVersion.trim()) problems.push("strategyVersion must be non-empty");
  if (config.enabledCities.length === 0) problems.push("at least one city must be enabled");
  if (Object.keys(config.modelWeights).length === 0) problems.push("modelWeights must not be empty");
  if (Object.values(config.modelWeights).some((w) => !Number.isFinite(w) || w < 0)) {
    problems.push("every model weight must be a non-negative finite number");
  }
  if (Object.values(config.modelWeights).reduce((a, b) => a + b, 0) <= 0) {
    problems.push("model weights must sum to a positive number");
  }
  if (config.positionSizeContracts <= 0) problems.push("positionSizeContracts must be positive");
  if (config.slippageBufferUsd < 0) problems.push("slippageBufferUsd must be non-negative");
  if (config.gate.requireVerifiedSettlement !== true) {
    problems.push("requireVerifiedSettlement must be true; unverified settlement may never be traded");
  }
  if (config.gate.minNetEdge <= 0) problems.push("minNetEdge must be positive");
  if (config.gate.minPriceUsd >= config.gate.maxPriceUsd) problems.push("minPriceUsd must be below maxPriceUsd");
  if (config.gate.enabledStrategyClasses.length === 0) {
    problems.push("at least one strategy class must be enabled, and only with a defined rule");
  }
  if (config.feeModelVersion !== FEE_MODEL_VERSION) {
    problems.push(
      `feeModelVersion ${config.feeModelVersion} does not match the built fee model ${FEE_MODEL_VERSION}`,
    );
  }
  if (config.maxQuoteAgeMs <= 0) problems.push("maxQuoteAgeMs must be positive");
  if (config.maxForecastAgeMs <= 0) problems.push("maxForecastAgeMs must be positive");

  for (const city of config.enabledCities) {
    if (!config.admittedSettlementFingerprints[city]) {
      problems.push(`city ${city} is enabled but has no admitted settlement fingerprint`);
    }
  }

  if (problems.length > 0) throw new ExperimentConfigError(problems);

  return {
    experimentId,
    configHash: hashConfig(config),
    frozenAt: frozenAt.toISOString(),
    config,
    mode: "PAPER",
  };
}

/**
 * Guard every read/write of collected evidence. Mixing experiments, or writing
 * rows under a hash that no longer matches the running config, silently
 * corrupts the sample.
 */
export function assertExperimentIsolation(params: {
  frozen: FrozenExperiment;
  rowExperimentId: string;
  rowConfigHash: string;
}): void {
  const { frozen, rowExperimentId, rowConfigHash } = params;
  if (rowExperimentId !== frozen.experimentId) {
    throw new Error(
      `Experiment isolation violated: row belongs to ${rowExperimentId}, running experiment is ${frozen.experimentId}`,
    );
  }
  if (rowConfigHash !== frozen.configHash) {
    throw new Error(
      `Config hash mismatch for ${frozen.experimentId}: row was collected under ${rowConfigHash}, ` +
        `running config is ${frozen.configHash}. A strategy change requires a NEW experiment.`,
    );
  }
}

/** Strategy classes that exist but must stay disabled until a rule is defined. */
export const STRATEGY_CLASSES_REQUIRING_A_DEFINED_RULE: readonly StrategyClass[] = Object.freeze([
  "CHEAP_TAIL_VALUE",
  "MID_PRICE_VALUE",
  "HIGH_CONFIDENCE_VALUE",
  "INTRADAY_OBSERVATION_EDGE",
  "MODEL_DISAGREEMENT",
  "FORECAST_REVISION",
]);
