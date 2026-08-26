/**
 * Kalshi fee model.
 *
 * This is the single most decision-critical module in the weather lab. The
 * research phase established that cheap contracts can look extremely attractive
 * on raw probability spread and stop being attractive once fees are charged, so
 * every edge calculation must route through here.
 *
 * Authoritative inputs, in order of preference:
 *
 * 1. `fee_type` and `fee_multiplier`, read per-series from the Kalshi API. A
 *    weather series currently reports `{ fee_type: "quadratic", fee_multiplier: 1 }`.
 *    We read these rather than assuming them, and we fail closed on anything we
 *    do not recognise.
 * 2. The rounding rule, from Kalshi's public API documentation: the trade fee is
 *    rounded **up to the nearest $0.0001 (one centicent), per fill** — not per
 *    order, and not to the nearest cent.
 *
 * The quadratic coefficient itself is pinned here as a named constant with a
 * fingerprint. If Kalshi republishes a different schedule, `FEE_MODEL_VERSION`
 * changes and every experiment frozen against the old value is invalidated
 * rather than silently repriced.
 *
 * Deliberately NOT modelled (and therefore never silently assumed to be zero in
 * a way that flatters a strategy):
 * - the non-direct-member rounding-fee/rebate accumulator, which can only ever
 *   make realised fees slightly *higher* than this function reports at the
 *   moment of a fill and is refunded in whole cents later. Treating it as zero
 *   is conservative for a rebate and anti-conservative for the intra-order
 *   rounding fee, so `FeeQuote.isLowerBound` marks the result accordingly.
 * - maker rebate programmes requiring negotiated/active-trader status.
 */

/** Bump when any constant or rule below changes. Frozen into experiment configs. */
export const FEE_MODEL_VERSION = "kalshi-quadratic-2026-08";

/** Kalshi quadratic trade-fee coefficient. */
export const QUADRATIC_FEE_COEFFICIENT = 0.07;

/** Official rounding increment: one centicent. Fees round UP to this. */
export const FEE_ROUNDING_INCREMENT_USD = 0.0001;

export type KalshiFeeType = "quadratic";

export type FeeSchedule = {
  /** Verbatim from the venue's series object. */
  feeType: string;
  /** Verbatim from the venue's series object. */
  feeMultiplier: number;
};

export type FeeRole = "taker" | "maker";

export type FeeQuote = {
  /** Total fee in dollars for the whole fill. */
  feeUsd: number;
  /** Fee expressed against premium paid, the number that kills cheap tails. */
  effectiveFeeFractionOfPremium: number | null;
  /** Per-contract fee in dollars. */
  feePerContractUsd: number;
  feeModelVersion: string;
  /**
   * True when unmodelled venue mechanics could make the realised fee higher.
   * Callers must not treat a `true` quote as an exact settled cost.
   */
  isLowerBound: boolean;
};

export class UnsupportedFeeScheduleError extends Error {
  constructor(schedule: FeeSchedule) {
    super(
      `Unsupported Kalshi fee schedule: feeType=${JSON.stringify(schedule.feeType)} ` +
        `feeMultiplier=${JSON.stringify(schedule.feeMultiplier)}. ` +
        `Fail closed: refusing to price an edge against an unrecognised fee model.`,
    );
    this.name = "UnsupportedFeeScheduleError";
  }
}

/** Round up to the next centicent, avoiding binary-float false positives. */
export function roundUpToCenticent(usd: number): number {
  if (!Number.isFinite(usd)) throw new RangeError(`fee must be finite, got ${usd}`);
  if (usd <= 0) return 0;
  const units = usd / FEE_ROUNDING_INCREMENT_USD;
  // 1e-9 absorbs representation error so 0.0034 does not become 0.0035.
  const rounded = Math.ceil(units - 1e-9);
  return Number((rounded * FEE_ROUNDING_INCREMENT_USD).toFixed(4));
}

function assertSupported(schedule: FeeSchedule): void {
  if (schedule.feeType !== "quadratic") throw new UnsupportedFeeScheduleError(schedule);
  if (!Number.isFinite(schedule.feeMultiplier) || schedule.feeMultiplier <= 0) {
    throw new UnsupportedFeeScheduleError(schedule);
  }
}

/**
 * Trade fee for a single fill of `contracts` at `price` (dollars, 0..1).
 *
 * Rounding is applied once to the whole fill, per the venue's per-fill rule.
 * Splitting one economic fill into several calls will therefore overstate fees;
 * callers walking an order-book ladder should aggregate the ladder into the
 * fills the venue would actually produce before pricing them.
 */
export function quoteFee(params: {
  price: number;
  contracts: number;
  schedule: FeeSchedule;
  role?: FeeRole;
}): FeeQuote {
  const { price, contracts, schedule, role = "taker" } = params;
  assertSupported(schedule);

  if (!Number.isFinite(price) || price < 0 || price > 1) {
    throw new RangeError(`price must be within [0,1] dollars, got ${price}`);
  }
  if (!Number.isFinite(contracts) || contracts < 0) {
    throw new RangeError(`contracts must be non-negative, got ${contracts}`);
  }
  if (contracts === 0) {
    return {
      feeUsd: 0,
      effectiveFeeFractionOfPremium: null,
      feePerContractUsd: 0,
      feeModelVersion: FEE_MODEL_VERSION,
      isLowerBound: false,
    };
  }

  // Kalshi charges the quadratic trade fee on taker volume. Resting liquidity is
  // not charged the taker fee; where a negotiated maker fee applies it is not
  // public per-market data, so we model maker as zero and mark it a lower bound.
  const raw =
    role === "taker"
      ? QUADRATIC_FEE_COEFFICIENT * schedule.feeMultiplier * contracts * price * (1 - price)
      : 0;

  const feeUsd = roundUpToCenticent(raw);
  const premium = price * contracts;

  return {
    feeUsd,
    effectiveFeeFractionOfPremium: premium > 0 ? feeUsd / premium : null,
    feePerContractUsd: feeUsd / contracts,
    feeModelVersion: FEE_MODEL_VERSION,
    isLowerBound: role === "maker",
  };
}

/**
 * Fee expressed in probability points, so it can be subtracted directly from a
 * model-probability-versus-price edge.
 *
 * A YES contract bought at `price` pays $1. Paying `feeUsd` on `contracts`
 * contracts is economically identical to paying `feeUsd / contracts` more per
 * contract, which is a straight shift of the breakeven probability.
 */
export function feeInProbabilityPoints(params: {
  price: number;
  contracts: number;
  schedule: FeeSchedule;
  role?: FeeRole;
}): number {
  return quoteFee(params).feePerContractUsd;
}

/**
 * Cheap-tail stress table. Exists because the research phase specifically
 * flagged that a 5c contract's usable edge is not its raw probability spread.
 */
export function cheapTailFeeProfile(
  schedule: FeeSchedule,
  prices: readonly number[] = [0.01, 0.02, 0.03, 0.05, 0.1, 0.2],
  contracts = 100,
): Array<{ price: number; feeUsd: number; fractionOfPremium: number | null; feePerContractUsd: number }> {
  return prices.map((price) => {
    const q = quoteFee({ price, contracts, schedule });
    return {
      price,
      feeUsd: q.feeUsd,
      fractionOfPremium: q.effectiveFeeFractionOfPremium,
      feePerContractUsd: q.feePerContractUsd,
    };
  });
}
