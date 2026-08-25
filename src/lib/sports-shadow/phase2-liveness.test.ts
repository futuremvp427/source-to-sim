/**
 * PHASE-2 STARVATION FIX (2026-08-25) regression suite.
 *
 * Production evidence: 3,610 post-go-live source fills stayed PENDING with newSignals=0
 * for hours. Two proven causes, both covered here:
 *   1. the source poll window (6s) was SMALLER than PHASE2_DOWNSTREAM_RESERVE_MS (8s), so
 *      phase1IngestDeadline's flat subtraction gave Phase 1 the whole window and Phase 2
 *      exactly zero usable time, every cycle, forever.
 *   2. even when Phase 2 ran, execution was strictly oldest-first, so a large historical
 *      backlog consumed the entire bounded window and freshly detected followed-wallet
 *      trades were never reached.
 */

import { describe, expect, it } from "vitest";

import { FRESH_PENDING_QUOTA, PHASE2_DOWNSTREAM_RESERVE_MS, orderPendingFillsFreshFirst, phase1IngestDeadline } from "./source-poll.server";
import { SOURCE_INGEST_OVERRUN_ALLOWANCE_MS, SOURCE_LANE_BUDGET_MS, VENUE_MATCH_RESERVE_MS, sourceIngestDeadline } from "./worker.server";

function row(id: string, sourceTs: number) {
  return { id, sourceTs };
}

describe("Phase 2 always receives real, non-zero usable time", () => {
  it("the production source-poll window is now large enough to split (was 6s, smaller than the reserve)", () => {
    const laneStart = 0;
    const pollWindow = sourceIngestDeadline(laneStart) - laneStart;
    expect(pollWindow).toBe(SOURCE_LANE_BUDGET_MS - VENUE_MATCH_RESERVE_MS - SOURCE_INGEST_OVERRUN_ALLOWANCE_MS);
    expect(pollWindow).toBeGreaterThan(PHASE2_DOWNSTREAM_RESERVE_MS);
  });

  it("venue matching still keeps its full reserve", () => {
    const laneStart = 0;
    const laneDeadline = laneStart + SOURCE_LANE_BUDGET_MS;
    expect(laneDeadline - sourceIngestDeadline(laneStart)).toBe(VENUE_MATCH_RESERVE_MS + SOURCE_INGEST_OVERRUN_ALLOWANCE_MS);
    expect(VENUE_MATCH_RESERVE_MS).toBe(12_000);
  });

  it("the exact production window (laneStart..ingest cutoff) leaves Phase 2 a real slice, not zero", () => {
    const laneStart = 1_000_000;
    const pollDeadline = sourceIngestDeadline(laneStart);
    const phase1Cutoff = phase1IngestDeadline(pollDeadline, laneStart);
    expect(pollDeadline - phase1Cutoff).toBeGreaterThan(1_000);
    expect(phase1Cutoff).toBeGreaterThan(laneStart);
  });

  it("a window smaller than the reserve is split proportionally instead of starving Phase 2 (the exact production defect)", () => {
    const now = 0;
    const deadline = 6_000; // the old production window
    const cutoff = phase1IngestDeadline(deadline, now);
    expect(cutoff).toBe(3_000);
    expect(deadline - cutoff).toBeGreaterThan(0);
  });

  it("a comfortably large window still uses the fixed reserve", () => {
    expect(phase1IngestDeadline(500_000, 0)).toBe(500_000 - PHASE2_DOWNSTREAM_RESERVE_MS);
  });

  it("a tiny window and a no-deadline caller are unchanged", () => {
    expect(phase1IngestDeadline(500, 0)).toBe(500);
    expect(phase1IngestDeadline(Number.POSITIVE_INFINITY, 0)).toBe(Number.POSITIVE_INFINITY);
  });
});

describe("fresh PENDING work is executed before historical backlog", () => {
  it("fresh post-go-live rows run first, and the old backlog still runs after (bounded progress, never dropped)", () => {
    const old = Array.from({ length: 400 }, (_, i) => row(`old-${i}`, 1_000 + i));
    const fresh = Array.from({ length: 10 }, (_, i) => row(`fresh-${i}`, 9_000_000 + i));
    const { ordered, freshCount, oldCount } = orderPendingFillsFreshFirst([...old, ...fresh]);
    expect(ordered.length).toBe(410);
    expect(ordered.slice(0, 10).map((r) => r.id)).toEqual(fresh.map((r) => r.id));
    expect(freshCount).toBe(FRESH_PENDING_QUOTA);
    expect(oldCount).toBe(410 - FRESH_PENDING_QUOTA);
    // nothing is discarded -- the old backlog still gets whatever budget remains
    expect(new Set(ordered.map((r) => r.id)).size).toBe(410);
  });

  it("a queue smaller than the selection slice still runs newest-fresh work first", () => {
    const rows = [row("a", 100), row("b", 200), row("c", 300)];
    const { ordered, freshCount, oldCount } = orderPendingFillsFreshFirst(rows, 2);
    expect(ordered.map((r) => r.id)).toEqual(["b", "c", "a"]);
    expect(freshCount).toBe(2);
    expect(oldCount).toBe(1);
  });

  it("fresh rows stay chronological among themselves so episode aggregation order is preserved", () => {
    const rows = [row("c", 300), row("a", 100), row("b", 200)];
    expect(orderPendingFillsFreshFirst(rows, 3).ordered.map((r) => r.id)).toEqual(["a", "b", "c"]);
  });

  it("is deterministic and restart-safe: identical input always yields identical order, ties broken by id", () => {
    const rows = [row("z", 500), row("a", 500), row("m", 500)];
    const first = orderPendingFillsFreshFirst(rows, 2).ordered.map((r) => r.id);
    for (let i = 0; i < 3; i += 1) {
      expect(orderPendingFillsFreshFirst([...rows].reverse(), 2).ordered.map((r) => r.id)).toEqual(first);
    }
  });

  it("an empty or zero-quota queue is handled without throwing", () => {
    expect(orderPendingFillsFreshFirst([]).ordered).toEqual([]);
    const r = orderPendingFillsFreshFirst([row("a", 1)], 0);
    expect(r.freshCount).toBe(0);
    expect(r.ordered.map((x) => x.id)).toEqual(["a"]);
  });
});
