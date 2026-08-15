import { PILOT_RISK_LIMITS } from "./poligarch-config";

export type RiskCheck = { pass: boolean; label: string; detail: string };

export type SizingInput = {
  proportionalNotionalUsd: number;
  remainingBankrollUsd: number;
  remainingExposureUsd: number;
  price: number;
  minimumTradeQty: number;
  tickSize: number;
};

export type SizingResult =
  | { ok: true; notionalUsd: number; shares: number }
  | { ok: false; reason: string };

function roundToTick(value: number, tick: number): number {
  return Math.floor(value / tick) * tick;
}

/**
 * min(proportional signal, $2 order cap, remaining bankroll, remaining
 * exposure headroom). If the platform's minimum tradeable size can't be
 * cleared at that notional, SKIP — never increase size to compensate.
 */
export function computeLivePilotOrderSize(input: SizingInput): SizingResult {
  const cappedNotional = Math.min(
    input.proportionalNotionalUsd,
    PILOT_RISK_LIMITS.maxOrderNotionalUsd,
    input.remainingBankrollUsd,
    input.remainingExposureUsd,
  );

  if (cappedNotional <= 0) {
    return { ok: false, reason: "No bankroll or exposure headroom remaining." };
  }

  const rawShares = cappedNotional / input.price;
  if (rawShares < input.minimumTradeQty) {
    return {
      ok: false,
      reason: `Order at $${cappedNotional.toFixed(2)} produces ${rawShares.toFixed(4)} shares, below minimumTradeQty ${input.minimumTradeQty}.`,
    };
  }

  const shares = roundToTick(rawShares, input.tickSize);
  if (shares < input.minimumTradeQty) {
    return { ok: false, reason: "Tick-rounded size falls below minimumTradeQty." };
  }

  return { ok: true, notionalUsd: Number((shares * input.price).toFixed(2)), shares };
}

export function checkSignalAge(input: { sourceTsSeconds: number; nowSeconds: number }): RiskCheck {
  const ageSeconds = input.nowSeconds - input.sourceTsSeconds;
  return {
    pass: ageSeconds <= PILOT_RISK_LIMITS.maxSignalAgeSeconds,
    label: `Signal age <= ${PILOT_RISK_LIMITS.maxSignalAgeSeconds}s`,
    detail: `${ageSeconds}s`,
  };
}

export function checkSlippage(input: { sourcePrice: number; currentPrice: number }): RiskCheck {
  const slippageCents = Math.abs(input.currentPrice - input.sourcePrice) * 100;
  return {
    pass: slippageCents <= PILOT_RISK_LIMITS.maxAllowedSlippageCents,
    label: `Slippage <= ${PILOT_RISK_LIMITS.maxAllowedSlippageCents} cents`,
    detail: `${slippageCents.toFixed(2)} cents`,
  };
}

export function checkExposureCaps(input: {
  currentOpenExposureUsd: number;
  newOrderNotionalUsd: number;
}): RiskCheck {
  const projected = input.currentOpenExposureUsd + input.newOrderNotionalUsd;
  return {
    pass: projected <= PILOT_RISK_LIMITS.maxTotalOpenExposureUsd,
    label: `Total exposure <= $${PILOT_RISK_LIMITS.maxTotalOpenExposureUsd}`,
    detail: `$${projected.toFixed(2)} projected`,
  };
}

export function checkDailyLoss(input: { todayRealizedPnlUsd: number }): RiskCheck {
  const loss = Math.max(0, -input.todayRealizedPnlUsd);
  return {
    pass: loss < PILOT_RISK_LIMITS.maxDailyRealizedLossUsd,
    label: `Daily realized loss < $${PILOT_RISK_LIMITS.maxDailyRealizedLossUsd}`,
    detail: `$${loss.toFixed(2)}`,
  };
}

export function checkConsecutiveFailures(input: { consecutiveFailedOrders: number }): RiskCheck {
  return {
    pass: input.consecutiveFailedOrders < PILOT_RISK_LIMITS.maxConsecutiveFailedOrders,
    label: `Consecutive failed orders < ${PILOT_RISK_LIMITS.maxConsecutiveFailedOrders}`,
    detail: `${input.consecutiveFailedOrders}`,
  };
}

export function checkOpenPositions(input: { openLivePositions: number }): RiskCheck {
  return {
    pass: input.openLivePositions < PILOT_RISK_LIMITS.maxOpenLivePositions,
    label: `Open live positions < ${PILOT_RISK_LIMITS.maxOpenLivePositions}`,
    detail: `${input.openLivePositions}`,
  };
}
