import { describe, it, expect } from "vitest";
import {
  POLIGARCH_V2_WALLET,
  POLIGARCH_V2_EXPERIMENT_NAME,
  PILOT_RISK_LIMITS,
  isAllowedPilotSource,
} from "./poligarch-config";

describe("poligarch-config", () => {
  it("exposes the exact wallet and experiment name", () => {
    expect(POLIGARCH_V2_WALLET).toBe("0xb40e89677d59665d5188541ad860450a6e2a7cc9");
    expect(POLIGARCH_V2_EXPERIMENT_NAME).toBe("SHADOW V2: Poligarch");
  });

  it("exposes the exact pilot risk limits", () => {
    expect(PILOT_RISK_LIMITS).toEqual({
      bankrollUsd: 25,
      maxOrderNotionalUsd: 2,
      maxTotalOpenExposureUsd: 10,
      maxDailyRealizedLossUsd: 5,
      maxConsecutiveFailedOrders: 3,
      maxSignalAgeSeconds: 90,
      maxAllowedSlippageCents: 3,
      maxOpenLivePositions: 5,
    });
  });

  it("accepts only the exact wallet + exact experiment name", () => {
    expect(
      isAllowedPilotSource({ experimentName: "SHADOW V2: Poligarch", wallet: POLIGARCH_V2_WALLET }),
    ).toBe(true);
  });

  it("rejects the correct wallet under the V3 experiment name", () => {
    expect(
      isAllowedPilotSource({
        experimentName: "SHADOW V3 CAPACITY: Poligarch",
        wallet: POLIGARCH_V2_WALLET,
      }),
    ).toBe(false);
  });

  it("rejects other cohort wallets even with a spoofed name", () => {
    expect(
      isAllowedPilotSource({
        experimentName: "SHADOW V2: Poligarch",
        wallet: "0x044f334595a7fd42c143e11c8ec47f23c8d1d1f1", // gghff
      }),
    ).toBe(false);
  });

  it("rejects substring/prefix tricks", () => {
    expect(
      isAllowedPilotSource({ experimentName: "SHADOW V2: Poligarch2", wallet: POLIGARCH_V2_WALLET }),
    ).toBe(false);
    expect(
      isAllowedPilotSource({ experimentName: "SHADOW V2: Poligarch", wallet: POLIGARCH_V2_WALLET + "0" }),
    ).toBe(false);
  });

  it("rejects General Shadow entirely", () => {
    expect(
      isAllowedPilotSource({
        experimentName: "GENERAL SHADOW: Poligarch",
        wallet: POLIGARCH_V2_WALLET,
      }),
    ).toBe(false);
  });
});
