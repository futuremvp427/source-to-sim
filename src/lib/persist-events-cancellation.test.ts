import { describe, expect, it, vi } from "vitest";
import type { NormalizedEvent } from "./shadow-core";

/**
 * Regression for the 2026-08-14 systemic incident: pg_stat_statements proved
 * the actual source_events upsert never takes more than ~8s of real query
 * execution, yet stage_ms repeatedly recorded 44s-82s of wall-clock time for
 * it -- the request was still outstanding, holding a connection/request
 * slot, tens of seconds after the cycle's 40s deadline had already fired and
 * moved on. Promise.race (withDeadline/boundedStage) never cancels its
 * losing promise. persistEvents now accepts a real AbortSignal and threads
 * it into the Supabase call via .abortSignal(), so the cycle's own deadline
 * timer can actually cancel the outstanding request instead of merely
 * abandoning interest in its result.
 */

type UpsertOptions = { onConflict?: string; ignoreDuplicates?: boolean };

let capturedSignal: AbortSignal | undefined;
let capturedRows: unknown[] | undefined;
let capturedOptions: UpsertOptions | undefined;

vi.mock("@/integrations/supabase/client.server", () => ({
  supabaseAdmin: {
    from: (table: string) => {
      expect(table).toBe("source_events");
      return {
        upsert: (rows: unknown[], options: UpsertOptions) => {
          capturedRows = rows;
          capturedOptions = options;
          const chain = {
            select: () => chain,
            abortSignal: (signal: AbortSignal) => {
              capturedSignal = signal;
              return chain;
            },
            then: (
              resolve: (v: { data: unknown; error: unknown }) => void,
              reject: (e: unknown) => void,
            ) => {
              if (capturedSignal?.aborted) {
                reject(new DOMException("The operation was aborted.", "AbortError"));
                return;
              }
              resolve({ data: rows.map((_, i) => ({ id: `row-${i}` })), error: null });
            },
          };
          return chain;
        },
      };
    },
  },
}));

const { persistEventsForTest } = await import("./shadow.server");

function fakeEvent(eventKey: string): NormalizedEvent {
  return {
    eventKey,
    wallet: "0xabc",
    txHash: "0xdeadbeef",
    sourceNativeId: null,
    logIndex: "0",
    conditionId: "cond",
    asset: "asset",
    marketTitle: "market",
    outcome: "YES",
    slug: null,
    side: "BUY",
    shares: 1,
    price: 0.5,
    sourceTs: 1000,
    identityBasis: "source_id",
    identityDegraded: false,
    raw: {},
  };
}

describe("persistEvents real cancellation (2026-08-14 systemic incident)", () => {
  it("threads the provided AbortSignal into the Supabase call via .abortSignal()", async () => {
    capturedSignal = undefined;
    const controller = new AbortController();
    await persistEventsForTest([fakeEvent("k1")], true, controller.signal);
    expect(capturedSignal).toBe(controller.signal);
  });

  it("resolves normally when the signal is never aborted", async () => {
    capturedSignal = undefined;
    const controller = new AbortController();
    const inserted = await persistEventsForTest([fakeEvent("k1"), fakeEvent("k2")], true, controller.signal);
    expect(inserted).toBe(2);
  });

  it("rejects when the deadline has already fired the abort before the request settles", async () => {
    capturedSignal = undefined;
    const controller = new AbortController();
    controller.abort();
    await expect(persistEventsForTest([fakeEvent("k1")], true, controller.signal)).rejects.toThrow(/aborted/i);
  });

  it("still works with no signal at all (backward compatible)", async () => {
    capturedSignal = undefined;
    const inserted = await persistEventsForTest([fakeEvent("k1")], true, undefined);
    expect(inserted).toBe(1);
    expect(capturedSignal).toBeUndefined();
  });

  it("does not mutate the row shape or upsert conflict target", async () => {
    capturedRows = undefined;
    capturedOptions = undefined;
    await persistEventsForTest([fakeEvent("k1")], true, undefined);
    expect(capturedOptions).toEqual({ onConflict: "wallet,event_key", ignoreDuplicates: true });
    expect(capturedRows).toHaveLength(1);
  });
});
