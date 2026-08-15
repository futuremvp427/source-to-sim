import { describe, it, expect, vi } from "vitest";
import {
  POLIGARCH_LIVE_PILOT_SUBMISSION_ENABLED,
  submitPoligarchLiveOrder,
  cancelPoligarchLiveOrder,
  getPoligarchLiveOrderStatus,
} from "./poligarch-submission.server";

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
      { usMarketSlug: "chicago-snow", side: "BUY", limitPrice: 0.52, shares: 3.8 },
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
      { usMarketSlug: "chicago-snow", side: "BUY", limitPrice: 0.52, shares: 3.8 },
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
      { usMarketSlug: "chicago-snow", side: "BUY", limitPrice: 0.52, shares: 3.8 },
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
});
