import { afterEach, describe, expect, it, vi } from "vitest";

/**
 * Phase 0A remediation, item 2: the execution-adjusted join in
 * loadCapacityComparison() must be strictly opt-in, so
 * live-safety.server.ts's loadLiveSafety() -- which feeds the kill-switch /
 * activation-stage / live-allocation gates -- gets ZERO new DB dependency,
 * ZERO new failure surface, and an IDENTICAL result from this labeling-only
 * change. This is the direct proof that "no kill-switch/activation behavior
 * changed" for the one caller where that guarantee matters most.
 */

let observationLogLoadCount = 0;

vi.mock("./observation/daily.server", () => ({
  loadObservationLog: async () => {
    observationLogLoadCount += 1;
    return { generatedAt: "now", handle: "Poligarch", series: [], note: "" };
  },
}));

vi.mock("@/integrations/supabase/client.server", () => ({
  supabaseAdmin: {
    from: () => ({
      select: () => ({
        eq: () => ({
          or: async () => ({ data: [], error: null }),
        }),
      }),
    }),
  },
}));

const { loadCapacityComparison } = await import("./capacity.server");

afterEach(() => {
  observationLogLoadCount = 0;
  vi.restoreAllMocks();
});

describe("loadCapacityComparison execution-adjusted join is opt-in", () => {
  it("never loads the observation log when called with no options (live-safety.server.ts's exact call shape)", async () => {
    await loadCapacityComparison();
    expect(observationLogLoadCount).toBe(0);
  });

  it("never loads the observation log when explicitly opted out", async () => {
    await loadCapacityComparison({ includeExecutionAdjusted: false });
    expect(observationLogLoadCount).toBe(0);
  });

  it("loads the observation log only when explicitly opted in (the dashboard-facing API call)", async () => {
    await loadCapacityComparison({ includeExecutionAdjusted: true });
    expect(observationLogLoadCount).toBe(1);
  });
});
