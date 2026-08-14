import { describe, expect, it, vi } from "vitest";

/**
 * Regression for the production incident where mark_refresh had no budget of
 * its own: a stalled public CLOB /books chunk could consume most or all of
 * EXPERIMENT_DEADLINE_MS on its own, and if the platform's own hard request
 * timeout is at or below that, the worker never reaches releaseLease() and
 * gets stuck at state='running' until a later cycle reclaims it. mark_refresh
 * now gets the same boundedStage(deadline, fallback) treatment as every other
 * auxiliary stage (reconciliation/settlement/previews/copyability).
 */

vi.mock("@/integrations/supabase/client.server", () => ({ supabaseAdmin: {} }));

const { boundedStageForTest, MARK_REFRESH_DEADLINE_MS_FOR_TEST } = await import("./shadow.server");

function neverResolves<T>(): Promise<T> {
  return new Promise(() => {
    // intentionally never settles — simulates a stalled/unreachable CLOB request
  });
}

function resolvesAfter<T>(ms: number, value: T): Promise<T> {
  return new Promise((resolve) => setTimeout(() => resolve(value), ms));
}

describe("mark_refresh has its own bounded budget (production incident regression)", () => {
  it("a stalled CLOB request that never resolves cannot exceed the mark-refresh budget", async () => {
    const fallback = { updated: 0, failed: 0 };
    const startedAt = Date.now();
    const result = await boundedStageForTest(neverResolves(), 30, "mark_refresh", fallback);
    const elapsedMs = Date.now() - startedAt;
    expect(result).toEqual(fallback);
    // Resolves at the budget, not after waiting indefinitely.
    expect(elapsedMs).toBeLessThan(200);
  });

  it("work slower than the budget (repeated retries) cannot consume the full platform lifetime", async () => {
    const fallback = { updated: 0, failed: 0 };
    const startedAt = Date.now();
    const result = await boundedStageForTest(resolvesAfter(500, { updated: 9, failed: 0 }), 30, "mark_refresh", fallback);
    const elapsedMs = Date.now() - startedAt;
    expect(result).toEqual(fallback);
    // Returns promptly at the budget (~30ms), not after the full 500ms.
    expect(elapsedMs).toBeLessThan(200);
  });

  it("mark-refresh timeout produces the neutral zero fallback, never a fabricated mark count", async () => {
    const result = await boundedStageForTest(
      neverResolves<{ updated: number; failed: number }>(),
      10,
      "mark_refresh",
      { updated: 0, failed: 0 },
    );
    expect(result.updated).toBe(0);
  });

  it("a healthy, fast CLOB response still marks normally (real result wins the race)", async () => {
    const real = { updated: 42, failed: 1 };
    const result = await boundedStageForTest(Promise.resolve(real), MARK_REFRESH_DEADLINE_MS_FOR_TEST, "mark_refresh", {
      updated: 0,
      failed: 0,
    });
    expect(result).toEqual(real);
  });

  it("the configured mark-refresh budget is well below the per-experiment cycle deadline", () => {
    // Precise regression for the incident: a single stalled /books chunk can
    // legitimately take up to ~37s (3 attempts x 12s AbortSignal.timeout,
    // plus backoff) under fetchBooksBatched's existing retry policy. The
    // mark-refresh budget must be comfortably below that worst case AND
    // below EXPERIMENT_DEADLINE_MS, so mark_refresh can never be the reason
    // a cycle fails to reach releaseLease().
    const worstCaseSingleChunkMs = 12_000 * 3 + 300 + 600;
    expect(MARK_REFRESH_DEADLINE_MS_FOR_TEST).toBeLessThan(worstCaseSingleChunkMs);
    expect(MARK_REFRESH_DEADLINE_MS_FOR_TEST).toBeLessThanOrEqual(20_000);
  });
});
