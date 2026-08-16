import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Server-layer regression coverage proving live_safety_state control writes are
 * never reported as succeeded unless persistence is proven: a DB error and a
 * zero-row (no matching control row) update must both fail loudly instead of
 * letting a caller claim "Kill switch engaged" / "armed" / "activated".
 */

type Row = Record<string, unknown>;

function makeFake() {
  let row: Row | null = { id: "global" };
  let updateError: { message: string } | null = null;

  function builder() {
    let eqId: unknown = null;
    const b = {
      select() {
        return b;
      },
      eq(_col: string, val: unknown) {
        eqId = val;
        return b;
      },
      update(patch: Row) {
        void patch;
        return b;
      },
      then(resolve: (v: unknown) => unknown, reject?: (e: unknown) => unknown) {
        const matched = Boolean(row && row["id"] === eqId);
        return Promise.resolve({
          data: matched ? [{ id: eqId }] : [],
          error: updateError,
        }).then(resolve, reject);
      },
    };
    return b;
  }

  return {
    setRow: (r: Row | null) => {
      row = r;
    },
    setUpdateError: (e: { message: string } | null) => {
      updateError = e;
    },
    supabaseAdmin: { from: () => builder() },
  };
}

const fake = makeFake();

vi.mock("@/integrations/supabase/client.server", () => ({
  get supabaseAdmin() {
    return fake.supabaseAdmin;
  },
}));

const { engageKillSwitch, releaseKillSwitch, abortActivation } = await import("./live-safety.server");

beforeEach(() => {
  fake.setRow({ id: "global" });
  fake.setUpdateError(null);
});

describe("live-safety.server proven persistence", () => {
  it("engageKillSwitch reports success only when the row was actually updated", async () => {
    await expect(engageKillSwitch("user-1")).resolves.toMatchObject({ ok: true });
  });

  it("engageKillSwitch throws on a DB error rather than claiming the kill switch is engaged", async () => {
    fake.setUpdateError({ message: "statement timeout" });
    await expect(engageKillSwitch("user-1")).rejects.toThrow(/live_safety_state update failed/);
  });

  it("releaseKillSwitch throws when no control row matched", async () => {
    fake.setRow(null);
    await expect(releaseKillSwitch("user-1")).rejects.toThrow(/matched no row/);
  });

  it("abortActivation throws when no control row matched", async () => {
    fake.setRow(null);
    await expect(abortActivation("user-1")).rejects.toThrow(/matched no row/);
  });
});
