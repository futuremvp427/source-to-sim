import { describe, it, expect, vi } from "vitest";
import { previewPoligarchLiveOrder } from "./poligarch-preview.server";
import { POLIGARCH_V2_WALLET, POLIGARCH_V2_EXPERIMENT_NAME } from "./poligarch-config";

const baseSourceEvent = {
  id: "evt-1",
  experimentId: "exp-1",
  experimentName: POLIGARCH_V2_EXPERIMENT_NAME,
  wallet: POLIGARCH_V2_WALLET,
  conditionId: "0xcond",
  asset: "tok-a",
  marketTitle: "Will it snow in Chicago by Feb 1?",
  outcome: "YES",
  side: "BUY" as const,
  price: 0.5,
  sourceTs: 1_700_000_000,
};

function baseDeps(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    mapMarket: vi.fn(async () => ({
      status: "MAPPED" as const,
      usMarketSlug: "chicago-snow",
      reason: "exact",
    })),
    getCurrentBook: vi.fn(async () => ({
      bestBid: 0.49,
      bestAsk: 0.51,
      minimumTradeQty: 0.01,
      tickSize: 0.005,
    })),
    getPilotSafetyState: vi.fn(async () => ({
      killSwitchEngaged: false,
      activationStage: "preview" as const,
      armedAt: null,
      activatedAt: null,
      pilotBankrollUsd: 25,
      maxOrderNotionalUsd: 2,
      maxTotalExposureUsd: 10,
      maxDailyRealizedLossUsd: 5,
    })),
    getPilotLedgerSnapshot: vi.fn(async () => ({
      remainingBankrollUsd: 25,
      currentOpenExposureUsd: 0,
      todayRealizedPnlUsd: 0,
      consecutiveFailedOrders: 0,
      openLivePositions: 0,
    })),
    createOrGetIntent: vi.fn(async () => ({
      intentId: "intent-1",
      created: true,
      status: "PREVIEWED",
    })),
    updateIntentStatus: vi.fn(async () => ({})),
    nowSeconds: () => 1_700_000_030,
    ...overrides,
  };
}

describe("previewPoligarchLiveOrder", () => {
  it("rejects a non-allowlisted source without persisting an intent or calling PMUS", async () => {
    const deps = baseDeps();
    const result = await previewPoligarchLiveOrder(
      { ...baseSourceEvent, experimentName: "SHADOW V3 CAPACITY: Poligarch" },
      deps as never,
    );
    expect(result.overall).toBe("FAIL");
    expect(result.failReason).toMatch(/allowlist/i);
    expect(deps.mapMarket).not.toHaveBeenCalled();
    expect(deps.createOrGetIntent).not.toHaveBeenCalled();
  });

  it("SKIPs on unmapped market without ever calling risk checks", async () => {
    const deps = baseDeps({
      mapMarket: vi.fn(async () => ({
        status: "SKIP" as const,
        usMarketSlug: null,
        reason: "no candidate",
        skipReason: "LIVE_MARKET_MAPPING_UNVERIFIED" as const,
      })),
    });
    const result = await previewPoligarchLiveOrder(baseSourceEvent, deps as never);
    expect(result.overall).toBe("FAIL");
    expect(result.failReason).toBe("LIVE_MARKET_MAPPING_UNVERIFIED");
    expect(deps.createOrGetIntent).not.toHaveBeenCalled();
  });

  it("FAILs closed when the safety state is locked", async () => {
    const deps = baseDeps({
      getPilotSafetyState: vi.fn(async () => ({
        killSwitchEngaged: true,
        activationStage: "locked" as const,
        armedAt: null,
        activatedAt: null,
        pilotBankrollUsd: 0,
        maxOrderNotionalUsd: 0,
        maxTotalExposureUsd: 0,
        maxDailyRealizedLossUsd: 0,
      })),
    });
    const result = await previewPoligarchLiveOrder(baseSourceEvent, deps as never);
    expect(result.overall).toBe("FAIL");
    expect(result.failReason).toMatch(/kill switch|locked/i);
    expect(deps.mapMarket).not.toHaveBeenCalled();
    expect(deps.createOrGetIntent).not.toHaveBeenCalled();
  });

  it("FAILs closed on a stale signal", async () => {
    const deps = baseDeps({ nowSeconds: () => 1_700_000_200 });
    const result = await previewPoligarchLiveOrder(baseSourceEvent, deps as never);
    expect(result.overall).toBe("FAIL");
    expect(result.signalAgeSeconds).toBe(200);
    expect(deps.createOrGetIntent).not.toHaveBeenCalled();
  });

  it("PASSes and persists a PREVIEWED intent when every check clears, still never submitting", async () => {
    const deps = baseDeps();
    const result = await previewPoligarchLiveOrder(baseSourceEvent, deps as never);
    expect(result.overall).toBe("PASS");
    expect(deps.createOrGetIntent).toHaveBeenCalledTimes(1);
    expect(deps.updateIntentStatus).toHaveBeenCalledWith(
      "intent-1",
      expect.stringMatching(/PREVIEWED/),
      expect.any(Object),
    );
  });
});
