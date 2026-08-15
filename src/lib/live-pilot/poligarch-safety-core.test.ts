import { describe, it, expect } from "vitest";
import {
  POLIGARCH_LIVE_PILOT_SUBMISSION_ENABLED,
  PILOT_ACTIVATION_CONFIRM_PHRASE,
  canEnterPreview,
  canEnterLivePilot,
  isSubmissionReachable,
  type PilotSafetyState,
} from "./poligarch-safety-core";

const lockedState: PilotSafetyState = {
  killSwitchEngaged: true,
  activationStage: "locked",
  armedAt: null,
  activatedAt: null,
  pilotBankrollUsd: 0,
  maxOrderNotionalUsd: 0,
  maxTotalExposureUsd: 0,
  maxDailyRealizedLossUsd: 0,
};

describe("poligarch-safety-core", () => {
  it("has submission hard-disabled", () => {
    expect(POLIGARCH_LIVE_PILOT_SUBMISSION_ENABLED).toBe(false);
  });

  it("blocks preview while kill switch is engaged", () => {
    const gate = canEnterPreview(lockedState);
    expect(gate.allowed).toBe(false);
  });

  it("allows preview once kill switch is released and stage is locked", () => {
    const gate = canEnterPreview({ ...lockedState, killSwitchEngaged: false });
    expect(gate.allowed).toBe(true);
  });

  it("requires the exact confirm phrase to enter live_pilot stage", () => {
    const armedState: PilotSafetyState = {
      ...lockedState,
      killSwitchEngaged: false,
      activationStage: "preview",
    };
    expect(canEnterLivePilot(armedState, "wrong phrase").allowed).toBe(false);
    expect(canEnterLivePilot(armedState, PILOT_ACTIVATION_CONFIRM_PHRASE).allowed).toBe(true);
  });

  it("submission is never reachable while the hard constant is false, regardless of DB state", () => {
    const fullyArmedState: PilotSafetyState = {
      killSwitchEngaged: false,
      activationStage: "live_pilot",
      armedAt: "2026-08-21T00:00:00Z",
      activatedAt: "2026-08-21T00:00:00Z",
      pilotBankrollUsd: 25,
      maxOrderNotionalUsd: 2,
      maxTotalExposureUsd: 10,
      maxDailyRealizedLossUsd: 5,
    };
    const result = isSubmissionReachable(fullyArmedState);
    expect(result.reachable).toBe(false);
    expect(result.reasons).toContain("POLIGARCH_LIVE_PILOT_SUBMISSION_ENABLED is false.");
  });

  it("submission is unreachable while locked even hypothetically", () => {
    expect(isSubmissionReachable(lockedState).reachable).toBe(false);
  });
});
