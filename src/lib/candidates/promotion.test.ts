import { describe, expect, it } from "vitest";

import {
  REFERENCE_EXPERIMENT_NAME,
  REFERENCE_WALLET,
  buildPromotedExperiment,
  guardPromotion,
  promotedExperimentName,
} from "./promotion";

describe("promotion isolation", () => {
  it("creates a PAUSED experiment that the autonomous cycle cannot pick up", () => {
    const row = buildPromotedExperiment({ handle: "opopv.", wallet: "0xabc", nowSeconds: 1_786_000_000 });
    expect(row.enabled).toBe(false);
    expect(row.simulated).toBe(true);
    expect(row.name).toBe("CANDIDATE:opopv.");
    expect(row.name).not.toBe(REFERENCE_EXPERIMENT_NAME);
  });

  it("gives every candidate its own bankroll, cash and P&L", () => {
    const a = buildPromotedExperiment({ handle: "a", wallet: "0x1", nowSeconds: 1 });
    const b = buildPromotedExperiment({ handle: "b", wallet: "0x2", nowSeconds: 1 });
    expect(a.name).not.toBe(b.name);
    expect(a.cash).toBe(a.starting_cash);
    expect(a.realized_pnl).toBe(0);
    expect(b.realized_pnl).toBe(0);
  });

  it("refuses to promote an unresolved wallet", () => {
    expect(guardPromotion({ wallet: null, handle: "gghff" })).toEqual({
      ok: false,
      error: "Wallet unresolved — cannot promote.",
    });
  });

  it("never lets candidate data target the reference experiment", () => {
    const guard = guardPromotion({ wallet: REFERENCE_WALLET.toUpperCase(), handle: "badatmath." });
    expect(guard.ok).toBe(false);
    expect(promotedExperimentName("badatmath.")).not.toBe(REFERENCE_EXPERIMENT_NAME);
  });

  it("allows a normal resolved candidate", () => {
    expect(guardPromotion({ wallet: "0x7c63520c2ca9b336af0c205b9ccf68217bb393d4", handle: "opopv." })).toEqual({ ok: true });
  });
});
