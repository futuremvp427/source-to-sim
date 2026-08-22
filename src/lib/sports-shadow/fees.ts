/**
 * FINAL BUILD Part 11: versioned fee engines for Sports Forward Shadow's paper
 * execution simulator — PURE math only, no network/Supabase. fee=0 is never
 * acceptable for this research system: both formulas below are sourced from each
 * exchange's own current, officially published fee schedule (fetched directly from
 * docs.polymarket.us/fees and Kalshi's official fee-schedule/fee-rounding
 * documentation as of 2026-08-22), not a third-party estimate or blog summary.
 *
 * Every result carries `valid` + `reason`. Per the mission's explicit instruction, an
 * unreliable/indeterminate fee must be classified UNVERIFIED and its simulated result
 * excluded from "fully executable net P&L" — NEVER silently treated as fee=0. Callers
 * (paper.server.ts) must check `valid` before folding a fee into a net-P&L figure.
 */

import type { Venue } from "./types";

export type FeeResult = {
  feeUsd: number;
  valid: boolean;
  reason: string | null;
  feeModelVersion: string;
  effectiveDate: string;
};

function invalidFee(version: string, effectiveDate: string, reason: string): FeeResult {
  return { feeUsd: 0, valid: false, reason, feeModelVersion: version, effectiveDate };
}

function isValidPrice(priceUsd: number): boolean {
  // Prediction-market prices are conventionally quoted in [$0.01, $0.99] on both
  // venues; a price outside this range cannot be a genuine executable quote.
  return Number.isFinite(priceUsd) && priceUsd >= 0.01 && priceUsd <= 0.99;
}

function isValidContracts(contracts: number): boolean {
  return Number.isFinite(contracts) && contracts > 0;
}

/**
 * Round-half-to-even ("banker's rounding") to the nearest cent — PM-US's own
 * documented rounding rule, verbatim: "$0.025 rounds to $0.02, while $0.035 rounds to
 * $0.04." Ordinary Math.round rounds half AWAY from zero for positive numbers, which
 * is the WRONG rule here and would silently overstate PM-US fees by up to $0.005 per
 * fill whenever the raw fee lands exactly on a half-cent boundary.
 */
function roundHalfToEvenCents(usd: number): number {
  const cents = usd * 100;
  const floor = Math.floor(cents);
  const diff = cents - floor;
  const EPS = 1e-9;
  let roundedCents: number;
  if (Math.abs(diff - 0.5) < EPS) {
    roundedCents = floor % 2 === 0 ? floor : floor + 1;
  } else {
    roundedCents = Math.round(cents);
  }
  return roundedCents / 100;
}

/**
 * PM-US taker fee. Per docs.polymarket.us/fees (fetched directly 2026-08-22): "The
 * taker fee calculation follows this formula: Fee = Θ × C × p × (1 - p)", where C is
 * contract quantity and p is decimal trade price. "Taker fee (Θ): 0.06" — a single,
 * exchange-wide coefficient; the documentation does NOT publish a separate Sports-
 * specific coefficient, so this module does not fabricate one. "Effective exchange-wide
 * from 12 AM ET, Wednesday July 1, 2026." All calculations use banker's rounding to the
 * nearest cent.
 *
 * Maker orders are never modeled here — see router.ts's own doc comment on why an
 * aggressive copy-trade is always simulated as taker (Part 10's explicit "no assumed
 * maker rebate" requirement). PMUS_MAKER_REBATE_THETA is not implemented at all.
 */
export const PMUS_FEE_MODEL_VERSION = "PMUS_FEE_V1_2026-07-01";
const PMUS_TAKER_THETA = 0.06;

export function computePmusTakerFee(contracts: number, priceUsd: number): FeeResult {
  if (!isValidContracts(contracts)) {
    return invalidFee(PMUS_FEE_MODEL_VERSION, "2026-07-01", `contracts must be a finite positive number, got ${contracts}`);
  }
  if (!isValidPrice(priceUsd)) {
    return invalidFee(PMUS_FEE_MODEL_VERSION, "2026-07-01", `priceUsd must be in [0.01, 0.99], got ${priceUsd}`);
  }
  const rawFee = PMUS_TAKER_THETA * contracts * priceUsd * (1 - priceUsd);
  return {
    feeUsd: roundHalfToEvenCents(rawFee),
    valid: true,
    reason: null,
    feeModelVersion: PMUS_FEE_MODEL_VERSION,
    effectiveDate: "2026-07-01",
  };
}

/**
 * Kalshi taker fee. Per Kalshi's official fee schedule ("Fee Schedule for July 2026 -
 * 7.7.26 Update") and fee-rounding documentation (docs.kalshi.com/getting_started/
 * fee_rounding, fetched directly 2026-08-22): "fees = round up(M x 0.07 x C x P x
 * (1-P))", M=1 (standard contracts, no multiplier), rounded UP to the nearest $0.0001
 * ("centicent") — this is the documented BASE per-fill trade fee.
 *
 * Deliberately does NOT model Kalshi's separate cross-fill balance-rounding
 * accumulator/rebate mechanism (fee_rounding's "Balance adjustment" section): that
 * mechanism exists only to reconcile a REAL, continuously-running account's whole-cent
 * balance across a SEQUENCE of real fills sharing that account. A standalone simulated
 * research fill has no real balance to reconcile against, so modeling it would be
 * fabricating a cross-fill relationship that does not exist for a paper trade. This is
 * a documented, deliberate simplification in a KNOWN direction, not an unknown-
 * direction approximation: the accumulator mechanism only ever credits back PART of
 * the round-up amount, so omitting it means this module's fee is (very slightly) an
 * OVERESTIMATE of Kalshi's true cost — the safe direction for a system whose purpose
 * is to prove real edge exists, never to flatter it.
 */
export const KALSHI_FEE_MODEL_VERSION = "KALSHI_FEE_V1_2026-02-05";
const KALSHI_TAKER_COEFFICIENT = 0.07;
const CENTICENT_USD = 0.0001;

export function computeKalshiTakerFee(contracts: number, priceUsd: number): FeeResult {
  if (!isValidContracts(contracts)) {
    return invalidFee(KALSHI_FEE_MODEL_VERSION, "2026-02-05", `contracts must be a finite positive number, got ${contracts}`);
  }
  if (!isValidPrice(priceUsd)) {
    return invalidFee(KALSHI_FEE_MODEL_VERSION, "2026-02-05", `priceUsd must be in [0.01, 0.99], got ${priceUsd}`);
  }
  const rawFee = KALSHI_TAKER_COEFFICIENT * contracts * priceUsd * (1 - priceUsd);
  // Round UP (ceil), never to nearest -- Kalshi's own documented rule, and the
  // conservative direction (never understates the fee) if float precision lands a hair
  // under a centicent boundary.
  const feeUsd = Math.ceil(rawFee / CENTICENT_USD - 1e-9) * CENTICENT_USD;
  return {
    feeUsd: Math.round(feeUsd * 1e6) / 1e6, // strip float noise beyond centicent precision, never rounds the VALUE itself
    valid: true,
    reason: null,
    feeModelVersion: KALSHI_FEE_MODEL_VERSION,
    effectiveDate: "2026-02-05",
  };
}

/** Dispatch by venue — the only entry point paper.server.ts should call. */
export function computeTakerFee(venue: Venue, contracts: number, priceUsd: number): FeeResult {
  return venue === "PMUS" ? computePmusTakerFee(contracts, priceUsd) : computeKalshiTakerFee(contracts, priceUsd);
}
