/**
 * Phase 0A remediation, item 2: explicit labeling for the two distinct kinds
 * of P&L this system can report, so neither can be silently presented or
 * misread as the other.
 *
 * This module changes NO booking logic and NO historical numbers. It is pure
 * labeling/typing around already-computed values:
 *
 *   - "RAW IDEALIZED P&L" -- the paper ledger's realized_pnl as booked today.
 *     Every paper fill is priced at the exact source-wallet fill price (see
 *     shadow-core.ts's decideDynamicBuy/decideCompoundBuy/decideProportionalSell
 *     and shadow.server.ts's processPendingEvents), with no spread, slippage,
 *     order-book depth, latency, or fee modeling applied to the booked price.
 *     This number is a useful measure of *directional copy fidelity*, but it
 *     is NOT a realistic or executable trading result.
 *
 *   - "EXECUTION-ADJUSTED / SLIPPAGE-ADJUSTED P&L" -- the same settled
 *     history re-priced using the system's own observed follower-vs-leader
 *     slippage (src/lib/observation/slippage-asof.ts,
 *     src/lib/observation/milestones.ts's estimateSlippageAdjustedPnl, fed by
 *     live order-book samples in src/lib/copyability/observe.server.ts).
 *     This is the more honest approximation of what a real follower could
 *     have achieved, but it is still an estimate (median-slippage based,
 *     bounded sample, no-lookahead) -- not a guarantee of live results, and
 *     it may be UNAVAILABLE where insufficient copyability observations exist.
 *
 * Both labels are on every value this module wraps: neither figure can be
 * read out without its own explicit, non-optional description of what it is
 * and is not.
 */

export const RAW_IDEALIZED_PNL_LABEL = "RAW IDEALIZED P&L";

export const RAW_IDEALIZED_PNL_CAVEAT =
  "Every paper fill is booked at the exact source wallet's own reported fill price. " +
  "No bid/ask spread, order-book depth, latency, or trading fees are modeled in this number. " +
  "This is NOT a realistic or executable trading result.";

export const EXECUTION_ADJUSTED_PNL_LABEL = "EXECUTION-ADJUSTED / SLIPPAGE-ADJUSTED P&L";

export const EXECUTION_ADJUSTED_PNL_AVAILABLE_CAVEAT =
  "Re-prices the same settled history using this system's own observed follower-vs-leader " +
  "slippage samples (median-based, no-lookahead). A closer approximation of a realistic " +
  "result, but still an estimate, not a guarantee of live execution.";

export const EXECUTION_ADJUSTED_PNL_UNAVAILABLE_REASON_NO_SAMPLES =
  "No sufficient observed-slippage sample exists yet for this experiment.";

/** The idealized figure. isIdealized/isExecutable are always these literal values -- a
 *  consumer cannot construct one that claims to be executable. */
export type LabeledIdealizedPnl = {
  label: typeof RAW_IDEALIZED_PNL_LABEL;
  value: number;
  isIdealized: true;
  isExecutable: false;
  caveat: typeof RAW_IDEALIZED_PNL_CAVEAT;
};

export type LabeledExecutionAdjustedPnl =
  | {
      available: true;
      label: typeof EXECUTION_ADJUSTED_PNL_LABEL;
      value: number;
      isIdealized: false;
      isExecutable: false;
      caveat: typeof EXECUTION_ADJUSTED_PNL_AVAILABLE_CAVEAT;
      source: string;
    }
  | {
      available: false;
      label: typeof EXECUTION_ADJUSTED_PNL_LABEL;
      value: null;
      reason: string;
    };

export function labelRawIdealizedPnl(value: number): LabeledIdealizedPnl {
  return {
    label: RAW_IDEALIZED_PNL_LABEL,
    value,
    isIdealized: true,
    isExecutable: false,
    caveat: RAW_IDEALIZED_PNL_CAVEAT,
  };
}

export function labelExecutionAdjustedPnl(
  value: number | null,
  opts: { source: string; unavailableReason?: string | undefined } = { source: "unknown" },
): LabeledExecutionAdjustedPnl {
  if (value === null) {
    return {
      available: false,
      label: EXECUTION_ADJUSTED_PNL_LABEL,
      value: null,
      reason: opts.unavailableReason ?? EXECUTION_ADJUSTED_PNL_UNAVAILABLE_REASON_NO_SAMPLES,
    };
  }
  return {
    available: true,
    label: EXECUTION_ADJUSTED_PNL_LABEL,
    value,
    isIdealized: false,
    isExecutable: false,
    caveat: EXECUTION_ADJUSTED_PNL_AVAILABLE_CAVEAT,
    source: opts.source,
  };
}
