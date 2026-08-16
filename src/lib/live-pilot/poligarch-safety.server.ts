/**
 * Read model + admin mutations for the Poligarch V2 live-pilot safety-state
 * row.
 *
 * Scoped exclusively to `live_pilot_state` where
 * `pilot_id = 'poligarch_v2_live_pilot'` — this module never reads or writes
 * the global `live_safety_state` row used by the generic live-safety layer,
 * so arming/activating this pilot can never affect that row or any other
 * experiment's display (see supabase/migrations/20260815120000_poligarch_live_pilot_schema.sql).
 *
 * Write side only ever changes this single per-pilot control row; it never
 * touches experiments, trades, positions, or live_order_intents, and it
 * cannot submit an order (POLIGARCH_LIVE_PILOT_SUBMISSION_ENABLED is a
 * hard-coded false, unreachable from any runtime admin action here).
 *
 * Every stage-advancing mutation re-fetches current state, runs the
 * corresponding Task 7 gate function, and throws with the gate's exact
 * `reason` string on failure — before issuing any write. Kill-switch engage
 * and abort-to-locked are, like the analogous functions in
 * live-safety.server.ts, always-allowed emergency/reset actions with no gate
 * to satisfy.
 */

import { supabaseAdmin } from "@/integrations/supabase/client.server";

import {
  canEnterLivePilot,
  canEnterPreview,
  type PilotActivationStage,
  type PilotSafetyState,
} from "./poligarch-safety-core";

const PILOT_ID = "poligarch_v2_live_pilot";

type StateRow = {
  kill_switch_engaged: boolean;
  activation_stage: string;
  armed_at: string | null;
  activated_at: string | null;
  pilot_bankroll_usd: number | string;
  max_order_notional_usd: number | string;
  max_total_exposure_usd: number | string;
  max_daily_realized_loss_usd: number | string;
};

function toState(row: StateRow | null): PilotSafetyState {
  const stage: PilotActivationStage =
    row?.activation_stage === "preview" || row?.activation_stage === "live_pilot"
      ? row.activation_stage
      : "locked";
  return {
    killSwitchEngaged: row?.kill_switch_engaged ?? true,
    activationStage: stage,
    armedAt: row?.armed_at ?? null,
    activatedAt: row?.activated_at ?? null,
    pilotBankrollUsd: Number(row?.pilot_bankroll_usd ?? 0),
    maxOrderNotionalUsd: Number(row?.max_order_notional_usd ?? 0),
    maxTotalExposureUsd: Number(row?.max_total_exposure_usd ?? 0),
    maxDailyRealizedLossUsd: Number(row?.max_daily_realized_loss_usd ?? 0),
  };
}

async function readState(): Promise<PilotSafetyState> {
  const { data } = await supabaseAdmin
    .from("live_pilot_state")
    .select(
      "kill_switch_engaged, activation_stage, armed_at, activated_at, pilot_bankroll_usd, max_order_notional_usd, max_total_exposure_usd, max_daily_realized_loss_usd",
    )
    .eq("pilot_id", PILOT_ID)
    .maybeSingle();
  return toState((data as StateRow | null) ?? null);
}

/** Read-only current safety state for the Poligarch V2 live pilot. */
export async function loadPoligarchPilotSafety(): Promise<PilotSafetyState> {
  return readState();
}

/**
 * Persistence is PROVEN, never assumed: the update returns the affected
 * pilot_id, so a DB error or a zero-row (no matching pilot control row)
 * outcome throws rather than letting a caller report an engaged kill switch or
 * an advanced activation stage that never persisted. Gates and caps unchanged.
 */
async function writeState(patch: Record<string, unknown>, action: string): Promise<void> {
  const { data, error } = await supabaseAdmin
    .from("live_pilot_state")
    .update({
      ...patch,
      last_action: action,
      last_action_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    })
    .eq("pilot_id", PILOT_ID)
    .select("pilot_id");
  if (error) throw new Error(`live_pilot_state update failed: ${error.message}`);
  if (!data || data.length === 0) {
    throw new Error("live_pilot_state update matched no row; state was not persisted");
  }
}

/** Emergency stop. Always allowed, and immediately resets activation to locked. */
export async function engagePoligarchKillSwitch(userId: string): Promise<void> {
  await writeState(
    { kill_switch_engaged: true, activation_stage: "locked", activated_at: null, armed_at: null },
    `kill_switch_engaged by ${userId}`,
  );
}

/** Always allowed. The pilot remains locked until explicitly staged forward. */
export async function releasePoligarchKillSwitch(userId: string): Promise<void> {
  await writeState({ kill_switch_engaged: false }, `kill_switch_released by ${userId}`);
}

/** Step 1 of 2: locked -> preview. Gated by canEnterPreview. */
export async function enterPreviewStage(userId: string): Promise<void> {
  const state = await readState();
  const gate = canEnterPreview(state);
  if (!gate.allowed) throw new Error(gate.reason);
  await writeState(
    { activation_stage: "preview", armed_at: new Date().toISOString(), armed_by: userId },
    `preview_entered by ${userId}`,
  );
}

/** Step 2 of 2: preview -> live_pilot. Gated by canEnterLivePilot (requires the exact confirm phrase). */
export async function enterLivePilotStage(userId: string, confirmPhrase: string): Promise<void> {
  const state = await readState();
  const gate = canEnterLivePilot(state, confirmPhrase);
  if (!gate.allowed) throw new Error(gate.reason);
  await writeState(
    {
      activation_stage: "live_pilot",
      activated_at: new Date().toISOString(),
      activated_by: userId,
    },
    `live_pilot_entered by ${userId}`,
  );
}

/** Always allowed. Resets activation to locked without touching the kill switch. */
export async function abortToLocked(userId: string): Promise<void> {
  await writeState(
    { activation_stage: "locked", armed_at: null, activated_at: null },
    `activation_aborted by ${userId}`,
  );
}
