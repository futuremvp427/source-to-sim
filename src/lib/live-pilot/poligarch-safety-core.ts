/**
 * Hard-disabled regardless of any database state. Flipping this to true is
 * a deliberate source change requiring its own review — not something any
 * runtime admin action in this codebase can do.
 */
export const POLIGARCH_LIVE_PILOT_SUBMISSION_ENABLED = false;

export type PilotActivationStage = "locked" | "preview" | "live_pilot";

export type PilotSafetyState = {
  killSwitchEngaged: boolean;
  activationStage: PilotActivationStage;
  armedAt: string | null;
  activatedAt: string | null;
  pilotBankrollUsd: number;
  maxOrderNotionalUsd: number;
  maxTotalExposureUsd: number;
  maxDailyRealizedLossUsd: number;
};

export type ActivationGate = { allowed: boolean; reason: string };

export function canEnterPreview(state: PilotSafetyState): ActivationGate {
  if (state.killSwitchEngaged) return { allowed: false, reason: "Kill switch is engaged." };
  if (state.activationStage !== "locked")
    return { allowed: false, reason: `Already ${state.activationStage}.` };
  return { allowed: true, reason: "Preview stage allowed." };
}

export const PILOT_ACTIVATION_CONFIRM_PHRASE = "ACTIVATE POLIGARCH V2 LIVE PILOT";

export function canEnterLivePilot(state: PilotSafetyState, confirmPhrase: string): ActivationGate {
  if (state.killSwitchEngaged) return { allowed: false, reason: "Kill switch is engaged." };
  if (state.activationStage !== "preview")
    return { allowed: false, reason: "Must be in preview stage first." };
  if (confirmPhrase.trim() !== PILOT_ACTIVATION_CONFIRM_PHRASE)
    return { allowed: false, reason: "Confirmation phrase does not match." };
  return { allowed: true, reason: "Live-pilot stage confirmed." };
}

/**
 * Every condition from Step 8 of the spec, fail-closed: any single missing
 * condition makes submission unreachable.
 */
export function isSubmissionReachable(state: PilotSafetyState): {
  reachable: boolean;
  reasons: string[];
} {
  const reasons: string[] = [];
  if (!POLIGARCH_LIVE_PILOT_SUBMISSION_ENABLED)
    reasons.push("POLIGARCH_LIVE_PILOT_SUBMISSION_ENABLED is false.");
  if (state.killSwitchEngaged) reasons.push("Kill switch engaged.");
  if (state.activationStage !== "live_pilot")
    reasons.push(`Activation stage is ${state.activationStage}, not live_pilot.`);
  if (!(state.maxOrderNotionalUsd > 0)) reasons.push("maxOrderNotionalUsd is $0.");
  if (!(state.maxTotalExposureUsd > 0)) reasons.push("maxTotalExposureUsd is $0.");
  if (!(state.pilotBankrollUsd > 0)) reasons.push("pilotBankrollUsd is $0.");

  return { reachable: reasons.length === 0, reasons };
}
