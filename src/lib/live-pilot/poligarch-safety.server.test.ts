import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Deterministic regressions against a minimal in-memory fake of the exact
 * supabase-js query shapes poligarch-safety.server.ts issues: .from(table)
 * .select(...).eq(...).maybeSingle() and .from(table).update(patch).eq(...).
 *
 * This mocks the same module seam live-safety.server.ts's own pattern uses —
 * `@/integrations/supabase/client.server`'s `supabaseAdmin` export (see
 * src/lib/copyability/observe.server.test.ts for the precedent) — so the
 * mock matches how the real client is actually constructed and consumed,
 * not a fabricated interface.
 *
 * The fake only ever exposes a `live_pilot_state` table. Any call to
 * `.from()` with a different table name (in particular the global
 * `live_safety_state` table) throws, which is how these tests assert this
 * module never touches that row.
 */

type Row = Record<string, unknown>;

const PILOT_ID = "poligarch_v2_live_pilot";

function lockedRow(overrides: Partial<Row> = {}): Row {
  return {
    pilot_id: PILOT_ID,
    kill_switch_engaged: true,
    activation_stage: "locked",
    armed_at: null,
    activated_at: null,
    pilot_bankroll_usd: 0,
    max_order_notional_usd: 0,
    max_total_exposure_usd: 0,
    max_daily_realized_loss_usd: 0,
    ...overrides,
  };
}

function makeFakeDb() {
  let row: Row | null = lockedRow();
  let updateError: { message: string } | null = null;
  const updateMock = vi.fn();

  function makeBuilder(table: string) {
    if (table !== "live_pilot_state") {
      throw new Error(`unexpected table access: ${table} (must only ever touch live_pilot_state)`);
    }

    let mode: "select" | "update" = "select";
    let updatePatch: Row | null = null;
    let eqPilotId: string | null = null;

    const builder = {
      select() {
        return builder;
      },
      eq(col: string, val: unknown) {
        if (col !== "pilot_id") throw new Error(`unexpected filter column: ${col}`);
        eqPilotId = val as string;
        return builder;
      },
      update(patch: Row) {
        mode = "update";
        updatePatch = patch;
        updateMock(patch);
        return builder;
      },
      async maybeSingle() {
        if (mode === "update") {
          const matched = Boolean(row && row["pilot_id"] === eqPilotId);
          if (matched) Object.assign(row as Row, updatePatch);
          return { data: matched ? [{ pilot_id: eqPilotId }] : [], error: null };
        }
        const data = row && row["pilot_id"] === eqPilotId ? row : null;
        return { data, error: null };
      },
      then(resolve: (v: unknown) => unknown, reject?: (e: unknown) => unknown) {
        // update() calls in the real module are awaited directly without
        // .maybeSingle(); resolve the pending update here the same way.
        if (mode === "update") {
          const matched = Boolean(row && row["pilot_id"] === eqPilotId);
          if (matched) Object.assign(row as Row, updatePatch);
          return Promise.resolve({
            data: matched ? [{ pilot_id: eqPilotId }] : [],
            error: updateError,
          }).then(resolve, reject);
        }
        return Promise.resolve({ data: row, error: null }).then(resolve, reject);
      },
    };
    return builder;
  }

  return {
    getRow: () => row,
    setRow: (r: Row | null) => {
      row = r;
    },
    setUpdateError: (e: { message: string } | null) => {
      updateError = e;
    },
    updateMock,
    supabaseAdmin: {
      from: (table: string) => makeBuilder(table),
    },
  };
}

const fake = makeFakeDb();

vi.mock("@/integrations/supabase/client.server", () => ({
  get supabaseAdmin() {
    return fake.supabaseAdmin;
  },
}));

const { engagePoligarchKillSwitch, enterPreviewStage, enterLivePilotStage, abortToLocked } =
  await import("./poligarch-safety.server");

beforeEach(() => {
  fake.updateMock.mockClear();
  fake.setRow(lockedRow());
});

describe("poligarch-safety.server", () => {
  it("enterLivePilotStage rejects a wrong confirm phrase without calling the DB update path", async () => {
    fake.setRow(lockedRow({ kill_switch_engaged: false, activation_stage: "preview" }));

    await expect(enterLivePilotStage("user-1", "wrong phrase")).rejects.toThrow(
      /confirmation phrase/i,
    );

    expect(fake.updateMock).not.toHaveBeenCalled();
    expect(fake.getRow()?.["activation_stage"]).toBe("preview");
  });

  it("enterLivePilotStage proceeds to write once staged in preview with the correct confirm phrase", async () => {
    fake.setRow(lockedRow({ kill_switch_engaged: false, activation_stage: "preview" }));

    await enterLivePilotStage("user-1", "ACTIVATE POLIGARCH V2 LIVE PILOT");

    expect(fake.updateMock).toHaveBeenCalledTimes(1);
    expect(fake.getRow()?.["activation_stage"]).toBe("live_pilot");
    expect(fake.getRow()?.["activated_at"]).not.toBeNull();
  });

  it("enterPreviewStage rejects while the kill switch is engaged, without writing", async () => {
    fake.setRow(lockedRow({ kill_switch_engaged: true, activation_stage: "locked" }));

    await expect(enterPreviewStage("user-1")).rejects.toThrow(/kill switch/i);

    expect(fake.updateMock).not.toHaveBeenCalled();
  });

  it("enterPreviewStage advances locked -> preview once the kill switch is released", async () => {
    fake.setRow(lockedRow({ kill_switch_engaged: false, activation_stage: "locked" }));

    await enterPreviewStage("user-1");

    expect(fake.getRow()?.["activation_stage"]).toBe("preview");
    expect(fake.getRow()?.["armed_at"]).not.toBeNull();
  });

  it("engagePoligarchKillSwitch is always allowed and resets activation to locked", async () => {
    fake.setRow(lockedRow({ kill_switch_engaged: false, activation_stage: "live_pilot" }));

    await engagePoligarchKillSwitch("user-1");

    expect(fake.getRow()?.["kill_switch_engaged"]).toBe(true);
    expect(fake.getRow()?.["activation_stage"]).toBe("locked");
  });

  it("abortToLocked is always allowed and resets stage without touching the kill switch", async () => {
    fake.setRow(lockedRow({ kill_switch_engaged: false, activation_stage: "preview" }));

    await abortToLocked("user-1");

    expect(fake.getRow()?.["activation_stage"]).toBe("locked");
    expect(fake.getRow()?.["kill_switch_engaged"]).toBe(false);
  });
});
