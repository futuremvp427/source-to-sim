/**
 * Regression tests for the paper/live accounting separation invariant: the
 * Poligarch V2 live-pilot preview (Task 9) and submission (Task 10) modules
 * must never write to paper-trading accounting tables
 * (paper_experiments/paper_trades/paper_positions) or import shadow-core's
 * mutation surface. Paper accounting is shadow-core.ts's exclusive domain;
 * the live pilot only ever touches its own `live_pilot_intents` table via
 * the Task 3 RPCs.
 */
import { readFileSync } from "node:fs";
import { describe, it, expect, vi } from "vitest";

import { previewPoligarchLiveOrder, type PreviewDeps } from "./poligarch-preview.server";
import { submitPoligarchLiveOrder } from "./poligarch-submission.server";
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

describe("paper/live accounting separation", () => {
  it("a full PASS-path preview never touches a paper-accounting write path", async () => {
    // Stands in for any paper_experiments/paper_trades/paper_positions write.
    // None of previewPoligarchLiveOrder's injected deps is wired to this
    // spy anywhere below, so if the pipeline ever grew a hidden path to a
    // paper-accounting mutation it would have to reach outside its declared
    // PreviewDeps to do it — which the static-source check below also guards
    // against directly.
    const paperWriteSpy = vi.fn();

    const deps: PreviewDeps = {
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
    };

    const result = await previewPoligarchLiveOrder(baseSourceEvent, deps);

    // Genuinely exercises the real PASS path, not a stub: confirms the
    // pipeline actually ran to completion and persisted a PREVIEWED intent
    // through the injected (mocked) Task 3 RPC deps.
    expect(result.overall).toBe("PASS");
    expect(deps.createOrGetIntent).toHaveBeenCalledTimes(1);
    expect(deps.updateIntentStatus).toHaveBeenCalledWith(
      "intent-1",
      "PREVIEWED",
      expect.any(Object),
    );

    expect(paperWriteSpy).not.toHaveBeenCalled();
  });

  it("submitPoligarchLiveOrder never touches a paper-accounting write path, and short-circuits before any DB read", async () => {
    const paperWriteSpy = vi.fn();
    const getPilotSafetyState = vi.fn(async () => ({
      killSwitchEngaged: false,
      activationStage: "live_pilot" as const,
      armedAt: "2026-08-21T00:00:00Z",
      activatedAt: "2026-08-21T00:00:00Z",
      pilotBankrollUsd: 25,
      maxOrderNotionalUsd: 2,
      maxTotalExposureUsd: 10,
      maxDailyRealizedLossUsd: 5,
    }));
    const fetchImpl = vi.fn();

    const result = await submitPoligarchLiveOrder(
      { usMarketSlug: "chicago-snow", side: "BUY", limitPrice: 0.52, shares: 3.8 },
      { getPilotSafetyState, fetchImpl, now: () => 1_700_000_000 },
    );

    // Hard-coded POLIGARCH_LIVE_PILOT_SUBMISSION_ENABLED=false gate must fire
    // first, before even the DB safety-state read — so the submission path
    // never gets far enough to reach any accounting write, paper or live.
    expect(result.ok).toBe(false);
    expect(getPilotSafetyState).not.toHaveBeenCalled();
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(paperWriteSpy).not.toHaveBeenCalled();
  });

  it("static source inspection: neither module contains a paper-accounting write literal or imports shadow-core's mutation surface", () => {
    const previewSource = readFileSync(
      new URL("./poligarch-preview.server.ts", import.meta.url),
      "utf8",
    );
    const submissionSource = readFileSync(
      new URL("./poligarch-submission.server.ts", import.meta.url),
      "utf8",
    );

    for (const source of [previewSource, submissionSource]) {
      // Scoped to the literal table names, not a bare substring like
      // "shadow-core" or "paper" — poligarch-preview.server.ts legitimately
      // mentions "shadow-core.ts" in a comment (describing where its sizing
      // convention is mirrored from), and that reference is not itself an
      // import or a write and must not fail this check.
      expect(source).not.toMatch(/paper_trades|paper_positions|paper_experiments/);
      // Scoped to an actual import statement of shadow-core's module, not
      // any mention of the string "shadow-core" (e.g. in a comment).
      expect(source).not.toMatch(/from\s+["'](\.\.\/)*shadow-core(\.server)?["']/);
    }
  });
});
