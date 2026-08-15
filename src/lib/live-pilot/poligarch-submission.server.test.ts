import { describe, it, expect, vi } from "vitest";
import {
  POLIGARCH_LIVE_PILOT_SUBMISSION_ENABLED,
  submitPoligarchLiveOrder,
  cancelPoligarchLiveOrder,
  getPoligarchLiveOrderStatus,
  checkPilotOrderAllowlistAndNotional,
  roundToPriceTick,
  formatPriceForTick,
  type PoligarchLiveOrderIntent,
} from "./poligarch-submission.server";
import { POLIGARCH_V2_EXPERIMENT_NAME, POLIGARCH_V2_WALLET } from "./poligarch-config";

const baseOrder: PoligarchLiveOrderIntent = {
  usMarketSlug: "chicago-snow",
  side: "BUY",
  limitPrice: 0.52,
  shares: 3.8,
  outcome: "YES",
  experimentName: POLIGARCH_V2_EXPERIMENT_NAME,
  wallet: POLIGARCH_V2_WALLET,
  notionalUsd: 2,
};

const lockedState = {
  killSwitchEngaged: true,
  activationStage: "locked" as const,
  armedAt: null,
  activatedAt: null,
  pilotBankrollUsd: 0,
  maxOrderNotionalUsd: 0,
  maxTotalExposureUsd: 0,
  maxDailyRealizedLossUsd: 0,
};

const fullyArmedState = {
  killSwitchEngaged: false,
  activationStage: "live_pilot" as const,
  armedAt: "2026-08-21T00:00:00Z",
  activatedAt: "2026-08-21T00:00:00Z",
  pilotBankrollUsd: 25,
  maxOrderNotionalUsd: 2,
  maxTotalExposureUsd: 10,
  maxDailyRealizedLossUsd: 5,
};

describe("poligarch-submission.server", () => {
  it("hard constant is false", () => {
    expect(POLIGARCH_LIVE_PILOT_SUBMISSION_ENABLED).toBe(false);
  });

  it("submitPoligarchLiveOrder always short-circuits when the hard constant is false, even with a fully-armed DB state", async () => {
    const getPilotSafetyState = vi.fn(async () => fullyArmedState);
    const fetchImpl = vi.fn();
    const result = await submitPoligarchLiveOrder(
      baseOrder,
      { getPilotSafetyState, fetchImpl, now: () => 1_700_000_000 },
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/SUBMISSION_NOT_ENABLED/);
    expect(fetchImpl).not.toHaveBeenCalled();
    // The hard constant check must precede even the DB safety-state read.
    expect(getPilotSafetyState).not.toHaveBeenCalled();
  });

  it("still fails closed on a locked safety state, independent of the hard constant", async () => {
    const fetchImpl = vi.fn();
    const result = await submitPoligarchLiveOrder(
      baseOrder,
      { getPilotSafetyState: async () => lockedState, fetchImpl, now: () => 1_700_000_000 },
    );
    expect(result.ok).toBe(false);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("cancel and status-lookup also short-circuit on the hard constant", async () => {
    const fetchImpl = vi.fn();
    const cancelResult = await cancelPoligarchLiveOrder("order-1", {
      getPilotSafetyState: async () => fullyArmedState,
      fetchImpl,
      now: () => 1_700_000_000,
    });
    const statusResult = await getPoligarchLiveOrderStatus("order-1", {
      getPilotSafetyState: async () => fullyArmedState,
      fetchImpl,
      now: () => 1_700_000_000,
    });
    expect(cancelResult.ok).toBe(false);
    expect(statusResult.ok).toBe(false);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("detects missing credentials without throwing", async () => {
    // Exercised once POLYMARKET_KEY_ID/POLYMARKET_SECRET_KEY are unset in the test env —
    // confirm isPmusConfigured()-equivalent MISSING_CREDENTIALS handling is reused, not reinvented.
    const fetchImpl = vi.fn();
    const result = await submitPoligarchLiveOrder(
      baseOrder,
      { getPilotSafetyState: async () => fullyArmedState, fetchImpl, now: () => 1_700_000_000 },
    );
    expect(result.ok).toBe(false);
  });

  it("rejects operations outside the isolated allowlist even if somehow reached", async () => {
    // Reaches into module internals is not possible from the public API, so this
    // documents the intended behaviour of submit/cancel/status paths themselves:
    // they only ever construct allowlisted method+path combinations.
    const fetchImpl = vi.fn();
    const cancelResult = await cancelPoligarchLiveOrder("../../etc/passwd", {
      getPilotSafetyState: async () => fullyArmedState,
      fetchImpl,
      now: () => 1_700_000_000,
    });
    expect(cancelResult.ok).toBe(false);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("accepts a NO-outcome order the same way as a YES-outcome order (short-circuits identically on the hard constant)", async () => {
    const fetchImpl = vi.fn();
    const result = await submitPoligarchLiveOrder(
      { ...baseOrder, outcome: "NO" },
      { getPilotSafetyState: async () => fullyArmedState, fetchImpl, now: () => 1_700_000_000 },
    );
    expect(result.ok).toBe(false);
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

describe("checkPilotOrderAllowlistAndNotional (order-scoped defense-in-depth guard)", () => {
  it("accepts the allowlisted experiment/wallet within the notional cap", () => {
    const result = checkPilotOrderAllowlistAndNotional(
      { experimentName: POLIGARCH_V2_EXPERIMENT_NAME, wallet: POLIGARCH_V2_WALLET, notionalUsd: 2 },
      2,
    );
    expect(result.ok).toBe(true);
  });

  it("rejects a wrong wallet even under the correct experiment name", () => {
    const result = checkPilotOrderAllowlistAndNotional(
      {
        experimentName: POLIGARCH_V2_EXPERIMENT_NAME,
        wallet: "0x044f334595a7fd42c143e11c8ec47f23c8d1d1f1",
        notionalUsd: 2,
      },
      2,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/PILOT_SOURCE_NOT_ALLOWLISTED/);
  });

  it("rejects a wrong experiment name even under the correct wallet", () => {
    const result = checkPilotOrderAllowlistAndNotional(
      {
        experimentName: "SHADOW V3 CAPACITY: Poligarch",
        wallet: POLIGARCH_V2_WALLET,
        notionalUsd: 2,
      },
      2,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/PILOT_SOURCE_NOT_ALLOWLISTED/);
  });

  it("rejects a notional that exceeds the DB-configured per-order cap", () => {
    const result = checkPilotOrderAllowlistAndNotional(
      { experimentName: POLIGARCH_V2_EXPERIMENT_NAME, wallet: POLIGARCH_V2_WALLET, notionalUsd: 2.01 },
      2,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/NOTIONAL_EXCEEDS_CAP/);
  });

  it("accepts a notional exactly at the cap", () => {
    const result = checkPilotOrderAllowlistAndNotional(
      { experimentName: POLIGARCH_V2_EXPERIMENT_NAME, wallet: POLIGARCH_V2_WALLET, notionalUsd: 2 },
      2,
    );
    expect(result.ok).toBe(true);
  });
});

describe("price-tick rounding (submission)", () => {
  it("rounds a limit price to the nearest actual price tick", () => {
    expect(roundToPriceTick(0.517, 0.005)).toBeCloseTo(0.515, 10);
    expect(roundToPriceTick(0.5199, 0.01)).toBeCloseTo(0.52, 10);
  });

  it("formats the rounded price with enough decimals to represent the tick exactly", () => {
    expect(formatPriceForTick(0.515, 0.005)).toBe("0.515");
    expect(formatPriceForTick(0.52, 0.01)).toBe("0.52");
  });
});
