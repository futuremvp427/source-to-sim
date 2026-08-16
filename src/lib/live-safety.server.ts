/**
 * Read model + admin mutations for the live-capability safety layer.
 *
 * Read side is fully derived from persisted paper rows. Write side only ever
 * changes the single live_safety_state control row; it never touches
 * experiments, trades, positions, bankrolls or settlements, and it cannot
 * submit an order (no live execution path exists).
 */

import { supabaseAdmin } from "@/integrations/supabase/client.server";

import { loadCapacityComparison } from "./capacity.server";
import {
  ACTIVATION_CONFIRM_PHRASE,
  canActivate,
  canArm,
  computeLiveAllocation,
  evaluateQualification,
  LIVE_EXECUTION_IMPLEMENTED,
  type AllocationResult,
  type LiveSafetyState,
  type QualificationResult,
} from "./live-safety/core";

export type LiveSafetyData = {
  generatedAt: string;
  state: LiveSafetyState;
  qualifications: QualificationResult[];
  qualifiedCount: number;
  allocation: AllocationResult;
  exposureUsd: number | null;
  marksComplete: boolean;
  confirmPhrase: string;
  liveExecutionImplemented: boolean;
  note: string;
};

const NOTE =
  "PAPER SIMULATION / DERIVED. This layer gates a future live capability only. No live order submission path exists, so the effective live allocation is $0 by construction. Exposure and allocation are fail-closed: stale or incomplete marks make them Unavailable rather than estimated.";

type StateRow = {
  kill_switch_engaged: boolean;
  activation_stage: string;
  armed_at: string | null;
  activated_at: string | null;
  max_live_notional_usd: number | string;
  max_live_exposure_usd: number | string;
};

function toState(row: StateRow | null): LiveSafetyState {
  return {
    killSwitchEngaged: row?.kill_switch_engaged ?? true,
    activationStage:
      row?.activation_stage === "armed" || row?.activation_stage === "activated"
        ? row.activation_stage
        : "locked",
    armedAt: row?.armed_at ?? null,
    activatedAt: row?.activated_at ?? null,
    maxLiveNotionalUsd: Number(row?.max_live_notional_usd ?? 0),
    maxLiveExposureUsd: Number(row?.max_live_exposure_usd ?? 0),
  };
}

async function readState(): Promise<LiveSafetyState> {
  const { data } = await supabaseAdmin
    .from("live_safety_state")
    .select(
      "kill_switch_engaged, activation_stage, armed_at, activated_at, max_live_notional_usd, max_live_exposure_usd",
    )
    .eq("id", "global")
    .maybeSingle();
  return toState((data as StateRow | null) ?? null);
}

export async function loadLiveSafety(): Promise<LiveSafetyData> {
  const [state, capacity] = await Promise.all([readState(), loadCapacityComparison()]);

  const qualifications = capacity.rows.map((r) =>
    evaluateQualification({
      id: r.id,
      name: r.name,
      cohort: r.cohort,
      handle: r.handle,
      settledMarkets: r.settledMarkets,
      roi: r.roi,
      markCoveragePct: r.markCoveragePct,
      buys: r.buys,
      insufficientCashSkips: r.insufficientCashSkips,
    }),
  );
  const qualifiedCount = qualifications.filter((q) => q.status === "qualified").length;

  // Exposure is only reportable when every open position carries a fresh mark.
  const marksComplete =
    capacity.rows.length > 0 &&
    capacity.rows.every((r) => r.openPositions === r.markedOpenPositions);
  const exposureUsd = marksComplete
    ? capacity.rows.reduce((sum, r) => sum + r.openCostBasis, 0)
    : null;

  const allocation = computeLiveAllocation({
    state,
    // Live account equity is deliberately not wired to any authenticated
    // balance here: allocation must stay $0 while no live path exists.
    liveEquityUsd: null,
    exposureUsd,
    marksComplete,
    qualifiedExperiments: qualifiedCount,
  });

  return {
    generatedAt: new Date().toISOString(),
    state,
    qualifications,
    qualifiedCount,
    allocation,
    exposureUsd,
    marksComplete,
    confirmPhrase: ACTIVATION_CONFIRM_PHRASE,
    liveExecutionImplemented: LIVE_EXECUTION_IMPLEMENTED,
    note: NOTE,
  };
}

/**
 * Persistence is PROVEN, never assumed: the update returns the affected row
 * ids, so both a DB error and a zero-row (no matching control row) outcome
 * throw instead of letting a caller report "kill switch engaged" / "armed" /
 * "activated" for a write that never landed. Gates, caps and constants are
 * unchanged.
 */
async function writeState(patch: Record<string, unknown>, action: string): Promise<void> {
  const { data, error } = await supabaseAdmin
    .from("live_safety_state")
    .update({
      ...patch,
      last_action: action,
      last_action_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    })
    .eq("id", "global")
    .select("id");
  if (error) throw new Error(`live_safety_state update failed: ${error.message}`);
  if (!data || data.length === 0) {
    throw new Error("live_safety_state update matched no row; state was not persisted");
  }
}

export type SafetyActionResult = { ok: boolean; message: string };

/** Emergency stop. Always allowed, and immediately forces allocation to $0. */
export async function engageKillSwitch(userId: string): Promise<SafetyActionResult> {
  await writeState(
    { kill_switch_engaged: true, activation_stage: "locked", activated_at: null, armed_at: null },
    `kill_switch_engaged by ${userId}`,
  );
  return { ok: true, message: "Kill switch engaged. Activation reset to locked." };
}

export async function releaseKillSwitch(userId: string): Promise<SafetyActionResult> {
  await writeState({ kill_switch_engaged: false }, `kill_switch_released by ${userId}`);
  return { ok: true, message: "Kill switch released. System remains locked until armed." };
}

/** Step 1 of 2. */
export async function armActivation(userId: string): Promise<SafetyActionResult> {
  const data = await loadLiveSafety();
  const gate = canArm(data.state, data.qualifiedCount);
  if (!gate.allowed) return { ok: false, message: gate.reason };
  await writeState(
    { activation_stage: "armed", armed_at: new Date().toISOString(), armed_by: userId },
    `armed by ${userId}`,
  );
  return { ok: true, message: "Armed (step 1 of 2). Explicit confirmation still required." };
}

/** Step 2 of 2. */
export async function confirmActivation(
  userId: string,
  confirmPhrase: string,
): Promise<SafetyActionResult> {
  const data = await loadLiveSafety();
  const gate = canActivate(data.state, data.qualifiedCount, confirmPhrase);
  if (!gate.allowed) return { ok: false, message: gate.reason };
  await writeState(
    { activation_stage: "activated", activated_at: new Date().toISOString(), activated_by: userId },
    `activated by ${userId}`,
  );
  return {
    ok: true,
    message:
      "Activation confirmed. Effective live allocation stays $0 because no live execution path exists.",
  };
}

export async function abortActivation(userId: string): Promise<SafetyActionResult> {
  await writeState(
    { activation_stage: "locked", armed_at: null, activated_at: null },
    `activation_aborted by ${userId}`,
  );
  return { ok: true, message: "Activation aborted. System is locked." };
}
