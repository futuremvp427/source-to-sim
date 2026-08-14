import { describe, expect, it, vi } from "vitest";

/**
 * Regression for the 2026-08-14 SECOND failure wave (after PR #33). PR #33
 * gave persistEvents real cancellation, but paper_processing commits up to
 * PROCESS_BATCH=300 events sequentially inside the same 40s cycle deadline and
 * received no signal at all. Because Promise.race never cancels its losing
 * promise, the loop kept starting NEW process_source_event_atomic RPCs long
 * after the cycle had already failed, released its lease and let a fresh
 * attempt start -- compounding database load exactly during the statement
 * timeout wave. processPendingEvents now takes an AbortSignal.
 */

type Captured = { name: string; signal?: AbortSignal };

const calls: Captured[] = [];
let controller: AbortController;

function thenable(data: unknown) {
  let signal: AbortSignal | undefined;
  const name = (data as { __name?: string }).__name ?? "";
  const chain = {
    select: () => chain,
    eq: () => chain,
    in: () => chain,
    abortSignal: (s: AbortSignal) => {
      signal = s;
      return chain;
    },
    then: (
      resolve: (v: { data: unknown; error: unknown }) => void,
      reject: (e: unknown) => void,
    ) => {
      calls.push({ name, signal });
      if (signal?.aborted) {
        reject(new DOMException("The operation was aborted.", "AbortError"));
        return;
      }
      if (name === "process_source_event_atomic") {
        // Simulate the cycle deadline firing during the first commit.
        controller.abort();
        resolve({ data: { processed: true, applied: true }, error: null });
        return;
      }
      resolve({ data: (data as { rows?: unknown }).rows ?? [], error: null });
    },
  };
  return chain;
}

const pendingRows = [1, 2, 3].map((i) => ({
  id: `evt-${i}`,
  event_key: `key-${i}`,
  asset: `asset-${i}`,
  market_title: "Highest temperature in Paris",
  outcome: "Yes",
  side: "BUY",
  shares: 10,
  price: 0.4,
  source_ts: 1_000,
  first_seen_at: new Date().toISOString(),
}));

vi.mock("@/integrations/supabase/client.server", () => ({
  supabaseAdmin: {
    rpc: (name: string) => {
      if (name === "get_pending_experiment_source_events") {
        return thenable({ __name: name, rows: pendingRows });
      }
      return thenable({ __name: name, rows: [] });
    },
    from: () => thenable({ __name: "paper_positions", rows: [] }),
  },
}));

const { processPendingEventsForTest, CycleAbortedError } = await import("./shadow.server");

const experiment = {
  id: "exp-1",
  name: "SHADOW V2: badatmath.",
  wallet_address: "0xABC",
  starting_cash: 380,
  cash: 380,
  buy_amount: 5,
  poll_interval_seconds: 60,
  enabled: true,
  weather_only: false,
  realized_pnl: 0,
  // Every pending row above is pre-go-live history: the loop still consumes one
  // event per fenced transaction, which is exactly the abort path under test.
  follow_from_ts: 9_999_999,
};

const lease = { fence: 7, workerId: "ingest:test", lockId: "ingest:exp-1" };

describe("paper_processing real cancellation", () => {
  it("stops starting new event work once the cycle deadline aborts", async () => {
    calls.length = 0;
    controller = new AbortController();

    await expect(
      processPendingEventsForTest(experiment, lease, controller.signal),
    ).rejects.toBeInstanceOf(CycleAbortedError);

    const commits = calls.filter((c) => c.name === "process_source_event_atomic");
    // Exactly one event was committed before the abort; no NEW event RPC started.
    expect(commits).toHaveLength(1);
    expect(commits.length).toBeLessThan(pendingRows.length);
  });

  it("threads the real signal into every cancellable request", async () => {
    calls.length = 0;
    controller = new AbortController();
    await processPendingEventsForTest(experiment, lease, controller.signal).catch(() => undefined);

    for (const call of calls) {
      expect(call.signal, `${call.name} received no AbortSignal`).toBe(controller.signal);
    }
    expect(calls.map((c) => c.name)).toContain("get_pending_experiment_source_events");
    expect(calls.map((c) => c.name)).toContain("get_experiment_source_positions");
    expect(calls.map((c) => c.name)).toContain("process_source_event_atomic");
  });

  it("aborts an in-flight commit instead of letting it run past the deadline", async () => {
    calls.length = 0;
    controller = new AbortController();
    controller.abort();

    await expect(
      processPendingEventsForTest(experiment, lease, controller.signal),
    ).rejects.toBeTruthy();

    // The very first request is rejected by the aborted signal: nothing is
    // allowed to keep executing server-side after the cycle is over.
    expect(calls).toHaveLength(1);
  });
});
