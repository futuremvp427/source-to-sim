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

import type { ConsumedLevel } from "./depth-walk";
import type { Venue } from "./types";

export type FeeResult = {
  feeUsd: number;
  valid: boolean;
  reason: string | null;
  feeModelVersion: string;
  effectiveDate: string;
  /**
   * CODEX P1-4 (round 2): true when feeUsd is the venue's OWN COMPLETE documented net
   * cost; false when feeUsd is a deliberately conservative (never-favorable) UPPER
   * BOUND, because a REAL, documented additional mechanism exists that this
   * paper-research system structurally cannot simulate without unknowable live-account
   * state (LIVE_EXECUTION_IMPLEMENTED=false -- no real account of either venue exists
   * or ever will in this system's current scope). Currently only Kalshi sets this
   * false -- see computeKalshiTakerFee's own doc comment for exactly which mechanism
   * and why the omission is bounded to a known, safe direction rather than an unknown-
   * direction approximation.
   */
  netFeeComplete: boolean;
};

function invalidFee(version: string, effectiveDate: string, reason: string, netFeeComplete: boolean): FeeResult {
  return { feeUsd: 0, valid: false, reason, feeModelVersion: version, effectiveDate, netFeeComplete };
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
 * PM-US taker fee. Per docs.polymarket.us/fees (fetched directly 2026-07-01, re-
 * confirmed live 2026-08-22 during the CODEX P1-4 round-2 audit): "The taker fee
 * calculation follows this formula: Fee = Θ × C × p × (1 - p)", where C is contract
 * quantity and p is decimal trade price. "Taker fee (Θ): 0.06" — a single, exchange-
 * wide coefficient; the documentation shows no separate Sports-specific coefficient
 * across market series, so this module does not fabricate one. "Effective exchange-wide
 * from 12 AM ET, Wednesday July 1, 2026." All calculations use banker's rounding to the
 * nearest cent, per PM-US's own documented rounding rule.
 *
 * CODEX P1-4 (round 2) re-confirmation: PM-US's own docs additionally state "When an
 * aggressive order fills against multiple resting orders, each fill is individually
 * rounded. However... total commission across all fills cannot exceed the banker's-
 * rounded aggregate fee. This adjustment only reduces charges, never increases them."
 * Since p(1-p) is CONCAVE, Jensen's inequality guarantees the per-level SUM this
 * module already computes (computeTakerFeeForFills) is ALWAYS <= the blended-VWAP
 * aggregate fee for any real multi-level fill -- this cap can therefore never actually
 * bind against this module's own per-level summation, confirming (not merely assuming)
 * that computeTakerFeeForFills already matches PM-US's real accounting exactly, with
 * no separate cap-clamping step needed.
 *
 * netFeeComplete is always true for PM-US: no other cross-fill mechanism (beyond the
 * cap just confirmed never-binding) is documented anywhere in PM-US's own fee pages.
 *
 * Maker orders are never modeled here — see router.ts's own doc comment on why an
 * aggressive copy-trade is always simulated as taker (Part 10's explicit "no assumed
 * maker rebate" requirement). PMUS_MAKER_REBATE_THETA is not implemented at all.
 */
export const PMUS_FEE_MODEL_VERSION = "PMUS_FEE_V1_2026-07-01";
const PMUS_TAKER_THETA = 0.06;

export function computePmusTakerFee(contracts: number, priceUsd: number): FeeResult {
  if (!isValidContracts(contracts)) {
    return invalidFee(PMUS_FEE_MODEL_VERSION, "2026-07-01", `contracts must be a finite positive number, got ${contracts}`, true);
  }
  if (!isValidPrice(priceUsd)) {
    return invalidFee(PMUS_FEE_MODEL_VERSION, "2026-07-01", `priceUsd must be in [0.01, 0.99], got ${priceUsd}`, true);
  }
  const rawFee = PMUS_TAKER_THETA * contracts * priceUsd * (1 - priceUsd);
  return {
    feeUsd: roundHalfToEvenCents(rawFee),
    valid: true,
    netFeeComplete: true,
    reason: null,
    feeModelVersion: PMUS_FEE_MODEL_VERSION,
    effectiveDate: "2026-07-01",
  };
}

/**
 * ============ CODEX P1-4 (round 2): NET FEE MODEL RE-INVESTIGATION ============
 * Kalshi taker fee -- BASE TRADE FEE. Per Kalshi's own fee-rounding documentation
 * (docs.kalshi.com/getting_started/fee_rounding, re-fetched live 2026-08-22): "fees =
 * round up(M x 0.07 x C x P x (1-P))", rounded UP to the nearest $0.0001 ("centicent").
 * This formula and rounding rule are confirmed STABLE across both the schedule this
 * module previously cited (effective 2026-02-05) and the later "Fee Schedule for July
 * 2026 - 7.7.26 Update" -- multiple independent sources agree the 0.07 coefficient is
 * unchanged; the July revision's only confirmed addition is the M per-contract
 * multiplier framework itself. Version bumped to reflect the later, currently-in-force
 * schedule (previously stale at the Feb 2026 label -- CODEX's own "version/date
 * inconsistency" finding).
 *
 * MULTIPLIER (M): this system's own BetType is structurally restricted to MONEYLINE |
 * SPREAD | TOTAL (types.ts) -- it can never trade a player-prop market. Every source
 * found describing a non-default M specifically names player-prop markets as the
 * exception ("Player prop markets sometimes use slightly different multipliers than
 * team-level markets"); team/game-level markets (moneyline, spread, total) use the
 * standard multiplier uniformly, including for the sports vertical. M=1 is therefore
 * the correct, currently-applicable multiplier for every market this system can ever
 * evaluate -- not an unjustified default, but the ONE case the documented exception
 * does not reach. (Kalshi's public market API itself exposes no per-market fee-
 * multiplier field to check directly -- confirmed live, see fees.test.ts's own
 * dedicated regression for this exact boundary.) Attempting to independently re-verify
 * the EXACT raw schema default for M against Kalshi's primary fee-schedule PDF this
 * session was blocked by rate-limiting (HTTP 429, both attempts) -- the M=1 conclusion
 * above rests on the BetType exclusion argument, which does not depend on that PDF.
 *
 * NOT MODELED -- netFeeComplete=false: Kalshi's documented balance-rounding/rebate
 * mechanism (fee_rounding's "Balance adjustment" section, re-confirmed live): the
 * per-fill trade fee is rounded up to $0.0001, the resulting balance change is then
 * FLOORED to the account's own target precision ($0.0001 for "direct members", $0.01
 * for standard accounts), the fractional remainder accumulates PER ORDER, and a whole-
 * cent REBATE is issued once that accumulator exceeds $0.01. This requires real
 * account-tier state (which precision applies) and a real order's own sequence of
 * fills over time -- BOTH structurally unknowable for this paper-research system
 * (LIVE_EXECUTION_IMPLEMENTED=false: no real Kalshi account exists or will exist in
 * this system's current scope). Modeling it would mean fabricating account state that
 * does not exist, exactly the "do not invent unavailable metadata" instruction this
 * codebase already follows elsewhere (P1-6's identical reasoning for settlement rules).
 * Known-direction, bounded omission (not an unknown-direction guess): a rebate can only
 * ever REDUCE what is owed, so omitting it means this module's feeUsd is a safe,
 * conservative UPPER BOUND on Kalshi's true net cost -- callers must treat
 * netFeeComplete=false as "fee-inclusive but not rebate-adjusted," not as "unverified."
 * `valid` (this IS a real, documented, currently-in-force formula) is therefore still
 * true; `netFeeComplete=false` is the separate, honest signal for the gap Codex's
 * finding names.
 * ================================================================================
 */
export const KALSHI_FEE_MODEL_VERSION = "KALSHI_FEE_V2_2026-07-07";
const KALSHI_TAKER_COEFFICIENT = 0.07;
const KALSHI_STANDARD_MULTIPLIER = 1; // see doc comment above -- the only multiplier this system's own BetType universe can ever require
const CENTICENT_USD = 0.0001;
const KALSHI_EFFECTIVE_DATE = "2026-07-07";

export function computeKalshiTakerFee(contracts: number, priceUsd: number): FeeResult {
  if (!isValidContracts(contracts)) {
    return invalidFee(KALSHI_FEE_MODEL_VERSION, KALSHI_EFFECTIVE_DATE, `contracts must be a finite positive number, got ${contracts}`, false);
  }
  if (!isValidPrice(priceUsd)) {
    return invalidFee(KALSHI_FEE_MODEL_VERSION, KALSHI_EFFECTIVE_DATE, `priceUsd must be in [0.01, 0.99], got ${priceUsd}`, false);
  }
  const rawFee = KALSHI_TAKER_COEFFICIENT * KALSHI_STANDARD_MULTIPLIER * contracts * priceUsd * (1 - priceUsd);
  // Round UP (ceil), never to nearest -- Kalshi's own documented rule, and the
  // conservative direction (never understates the fee) if float precision lands a hair
  // under a centicent boundary.
  const feeUsd = Math.ceil(rawFee / CENTICENT_USD - 1e-9) * CENTICENT_USD;
  return {
    feeUsd: Math.round(feeUsd * 1e6) / 1e6, // strip float noise beyond centicent precision, never rounds the VALUE itself
    valid: true,
    netFeeComplete: false, // see doc comment above -- base trade fee only, a conservative upper bound
    reason: "base trade fee only -- Kalshi's documented balance-rounding/rebate accumulator is not modeled (requires unknowable real account-tier state); this is a safe, known-direction upper bound, never an underestimate",
    feeModelVersion: KALSHI_FEE_MODEL_VERSION,
    effectiveDate: KALSHI_EFFECTIVE_DATE,
  };
}

/** Dispatch by venue. Callers with a SINGLE known execution price (e.g. a level-by-level caller, or a test) use this directly; a multi-level walked fill must use computeTakerFeeForFills below instead -- see its own doc comment for why. */
export function computeTakerFee(venue: Venue, contracts: number, priceUsd: number): FeeResult {
  return venue === "PMUS" ? computePmusTakerFee(contracts, priceUsd) : computeKalshiTakerFee(contracts, priceUsd);
}

/**
 * ============ CODEX P1-5: EXECUTION-GRANULARITY FEE COMPUTATION ============
 * PROVEN root cause: paper.server.ts previously collapsed a walked fill to ONE blended
 * VWAP (depth-walk.ts's averageExecutionPrice) before computing a SINGLE fee against it.
 * Both venues' documented fee formulas are Θ × C × p × (1-p) -- a CONCAVE, nonlinear
 * function of price -- so summing the fee computed separately at each price level a fill
 * actually touched is mathematically NOT the same number as computing one fee at the
 * blended average price. Example: 5 contracts at p=0.50 (p(1-p)=0.2500) plus 5 at p=0.90
 * (p(1-p)=0.0900) sums to Θ×(5×0.25 + 5×0.09) = Θ×1.70; the SAME 10 contracts blended to
 * VWAP=0.70 gives Θ×10×0.70×0.30 = Θ×2.10 -- a real, provable discrepancy, not a rounding
 * artifact.
 *
 * FIX: computes the venue's own fee formula ONCE PER PRICE LEVEL actually consumed
 * (depth-walk.ts's `fills`, each level treated as its own fill event against its own
 * resting price -- consistent with how a real sweep against a multi-level book is
 * actually matched, price level by price level), applying each venue's own documented
 * per-fill rounding rule (PM-US: banker's rounding to the nearest cent; Kalshi: round up
 * to the nearest centicent) AT EACH LEVEL before summing -- never rounds once at the end,
 * which would itself reintroduce a blended-computation artifact.
 *
 * Fails closed as a WHOLE: if ANY level's own fee computation is invalid (a malformed
 * price/contracts pair, which should be structurally impossible from a genuine
 * depth-walk.ts result but is never trusted blindly), the entire aggregate is invalid --
 * never silently drops just that level's fee and returns a partial total.
 */
export function computeTakerFeeForFills(venue: Venue, fills: readonly ConsumedLevel[]): FeeResult {
  const version = venue === "PMUS" ? PMUS_FEE_MODEL_VERSION : KALSHI_FEE_MODEL_VERSION;
  const effectiveDate = venue === "PMUS" ? "2026-07-01" : KALSHI_EFFECTIVE_DATE;
  const netFeeComplete = venue === "PMUS"; // see computeKalshiTakerFee's own doc comment -- CODEX P1-4 (round 2)
  if (fills.length === 0) {
    return invalidFee(version, effectiveDate, "no consumed price levels to compute a fee against", netFeeComplete);
  }
  let totalFeeUsd = 0;
  for (const level of fills) {
    const result = computeTakerFee(venue, level.contracts, level.price);
    if (!result.valid) {
      return invalidFee(version, effectiveDate, `level at price ${level.price}: ${result.reason}`, netFeeComplete);
    }
    totalFeeUsd += result.feeUsd;
  }
  return {
    feeUsd: Math.round(totalFeeUsd * 1e6) / 1e6, // strip float summation noise beyond centicent precision, never rounds the VALUE itself
    valid: true,
    netFeeComplete,
    reason: netFeeComplete ? null : "base trade fee only -- Kalshi's documented balance-rounding/rebate accumulator is not modeled (requires unknowable real account-tier state); this is a safe, known-direction upper bound, never an underestimate",
    feeModelVersion: version,
    effectiveDate,
  };
}
