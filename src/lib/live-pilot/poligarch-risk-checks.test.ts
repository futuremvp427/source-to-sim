import { describe, it, expect } from "vitest";
import {
  computeLivePilotOrderSize,
  checkSignalAge,
  checkSlippage,
  checkExposureCaps,
  checkDailyLoss,
  checkConsecutiveFailures,
  checkOpenPositions,
} from "./poligarch-risk-checks";

describe("computeLivePilotOrderSize", () => {
  it("caps at $2 even when proportional signal size is larger", () => {
    const result = computeLivePilotOrderSize({
      proportionalNotionalUsd: 50,
      remainingBankrollUsd: 25,
      remainingExposureUsd: 10,
      price: 0.5,
      minimumTradeQty: 0.01,
      tickSize: 0.005,
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.notionalUsd).toBeLessThanOrEqual(2);
    }
  });

  it("SKIPs rather than increasing size when $2 cannot clear minimumTradeQty", () => {
    const result = computeLivePilotOrderSize({
      proportionalNotionalUsd: 50,
      remainingBankrollUsd: 25,
      remainingExposureUsd: 10,
      price: 0.99,
      minimumTradeQty: 10, // requires 10 shares * 0.99 = $9.90, far above the $2 cap
      tickSize: 0.005,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toMatch(/minimum/i);
    }
  });

  it("respects remaining bankroll and exposure headroom, whichever is smaller", () => {
    const result = computeLivePilotOrderSize({
      proportionalNotionalUsd: 50,
      remainingBankrollUsd: 1.5,
      remainingExposureUsd: 10,
      price: 0.5,
      minimumTradeQty: 0.01,
      tickSize: 0.005,
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.notionalUsd).toBeLessThanOrEqual(1.5);
    }
  });

  it("never lets tick-rounding push notional above the computed cap", () => {
    const result = computeLivePilotOrderSize({
      proportionalNotionalUsd: 50,
      remainingBankrollUsd: 25,
      remainingExposureUsd: 10,
      price: 0.33,
      minimumTradeQty: 0.01,
      tickSize: 0.1,
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.notionalUsd).toBeLessThanOrEqual(2);
    }
  });
});

describe("checkSignalAge", () => {
  it("passes within the 90s window", () => {
    const now = 1_700_000_100;
    expect(checkSignalAge({ sourceTsSeconds: 1_700_000_020, nowSeconds: now }).pass).toBe(true);
  });
  it("fails past 90s", () => {
    const now = 1_700_000_200;
    expect(checkSignalAge({ sourceTsSeconds: 1_700_000_020, nowSeconds: now }).pass).toBe(false);
  });
});

describe("checkSlippage", () => {
  it("passes within 3 cents", () => {
    expect(checkSlippage({ sourcePrice: 0.5, currentPrice: 0.52 }).pass).toBe(true);
  });
  it("fails beyond 3 cents", () => {
    expect(checkSlippage({ sourcePrice: 0.5, currentPrice: 0.54 }).pass).toBe(false);
  });
});

describe("checkExposureCaps", () => {
  it("fails when adding the order would exceed $10 total exposure", () => {
    expect(
      checkExposureCaps({ currentOpenExposureUsd: 9, newOrderNotionalUsd: 2 }).pass,
    ).toBe(false);
  });
  it("passes exactly at the cap", () => {
    expect(
      checkExposureCaps({ currentOpenExposureUsd: 8, newOrderNotionalUsd: 2 }).pass,
    ).toBe(true);
  });
});

describe("checkDailyLoss", () => {
  it("fails once today's realized loss reaches $5", () => {
    expect(checkDailyLoss({ todayRealizedPnlUsd: -5 }).pass).toBe(false);
    expect(checkDailyLoss({ todayRealizedPnlUsd: -4.99 }).pass).toBe(true);
  });
});

describe("checkConsecutiveFailures", () => {
  it("fails at 3 consecutive failures", () => {
    expect(checkConsecutiveFailures({ consecutiveFailedOrders: 3 }).pass).toBe(false);
    expect(checkConsecutiveFailures({ consecutiveFailedOrders: 2 }).pass).toBe(true);
  });
});

describe("checkOpenPositions", () => {
  it("fails at 5 open live positions", () => {
    expect(checkOpenPositions({ openLivePositions: 5 }).pass).toBe(false);
    expect(checkOpenPositions({ openLivePositions: 4 }).pass).toBe(true);
  });
});
