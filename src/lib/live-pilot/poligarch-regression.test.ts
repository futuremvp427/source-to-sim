/**
 * Task 13: consolidated regression suite for the Poligarch V2 live pilot.
 *
 * Covers, in one place, the invariants from earlier tasks that matter most
 * for safety: the allowlist rejects every other cohort member and accepts
 * only the exact Poligarch V2 pair; the kill switch blocks regardless of
 * stage; a locked/zero-cap state blocks submission reachability even when
 * other conditions look armed; and the confirm phrase must match exactly to
 * advance to live_pilot.
 *
 * OTHER_WALLETS is verified against the real committed source, not copied
 * blindly from the task brief:
 *   - badatmath., gghff, Weather-Guru, HighTempTation: src/lib/v2-cohort.ts
 *     (V2_COHORT). The brief's badatmath wallet
 *     ("0x0badatmathwallet00000000000000000000000") was a placeholder and
 *     did not match the real wallet in V2_COHORT
 *     ("0x8fbd7cf5f806f563080864694415829f7229a959"); corrected here.
 *   - RN1, swisstony: src/lib/general-shadow.ts (GS_COHORT). These matched
 *     the brief exactly.
 */
import { describe, it, expect } from "vitest";
import { isAllowedPilotSource, POLIGARCH_V2_WALLET } from "./poligarch-config";
import {
  canEnterPreview,
  canEnterLivePilot,
  isSubmissionReachable,
  PILOT_ACTIVATION_CONFIRM_PHRASE,
} from "./poligarch-safety-core";

const OTHER_WALLETS: Record<string, string> = {
  "SHADOW V3 CAPACITY: Poligarch": POLIGARCH_V2_WALLET,
  "SHADOW V2: badatmath.": "0x8fbd7cf5f806f563080864694415829f7229a959",
  "SHADOW V2: gghff": "0x044f334595a7fd42c143e11c8ec47f23c8d1d1f1",
  "SHADOW V2: Weather-Guru": "0xb6fbce093cdd139858c44148a6598d8ec028c038",
  "SHADOW V2: HighTempTation": "0x6011655c4afb76f36dd1b08a137a1ba73466b31e",
  "GENERAL SHADOW: RN1": "0x2005d16a84ceefa912d4e380cd32e7ff827875ea",
  "GENERAL SHADOW: swisstony": "0x204f72f35326db932158cba6adff0b9a1da95e14",
};

describe("allowlist regression: only Poligarch V2 accepted", () => {
  it.each(Object.entries(OTHER_WALLETS))("rejects %s", (experimentName, wallet) => {
    expect(isAllowedPilotSource({ experimentName, wallet })).toBe(false);
  });

  it("accepts only the exact Poligarch V2 pair", () => {
    expect(
      isAllowedPilotSource({ experimentName: "SHADOW V2: Poligarch", wallet: POLIGARCH_V2_WALLET }),
    ).toBe(true);
  });
});

describe("kill switch / activation regression", () => {
  const base = {
    killSwitchEngaged: true,
    activationStage: "locked" as const,
    armedAt: null,
    activatedAt: null,
    pilotBankrollUsd: 0,
    maxOrderNotionalUsd: 0,
    maxTotalExposureUsd: 0,
    maxDailyRealizedLossUsd: 0,
  };

  it("engaged kill switch blocks preview regardless of stage", () => {
    expect(canEnterPreview({ ...base, killSwitchEngaged: true, activationStage: "preview" }).allowed).toBe(false);
  });

  it("locked activation blocks submission reachability even with caps set", () => {
    expect(
      isSubmissionReachable({
        ...base,
        killSwitchEngaged: false,
        activationStage: "locked",
        maxOrderNotionalUsd: 2,
        maxTotalExposureUsd: 10,
        pilotBankrollUsd: 25,
      }).reachable,
    ).toBe(false);
  });

  it("zero caps block submission reachability even at live_pilot stage", () => {
    expect(
      isSubmissionReachable({
        ...base,
        killSwitchEngaged: false,
        activationStage: "live_pilot",
        maxOrderNotionalUsd: 0,
        maxTotalExposureUsd: 0,
        pilotBankrollUsd: 0,
      }).reachable,
    ).toBe(false);
  });

  it("wrong confirm phrase never advances to live_pilot", () => {
    expect(
      canEnterLivePilot({ ...base, killSwitchEngaged: false, activationStage: "preview" }, "close enough").allowed,
    ).toBe(false);
    expect(
      canEnterLivePilot(
        { ...base, killSwitchEngaged: false, activationStage: "preview" },
        PILOT_ACTIVATION_CONFIRM_PHRASE,
      ).allowed,
    ).toBe(true);
  });
});
