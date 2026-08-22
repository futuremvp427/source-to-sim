/**
 * SOAK INCIDENT (2026-08-22) regression suite.
 *
 * Reproduces the exact production starvation shape that made the first operational soak
 * invalid: continuously heavy source ingestion consumed the whole shared 30s lane budget,
 * so (a) durably-PENDING post-go-live fills never reached downstream classification, and
 * (b) both venue matching lanes returned deadlineReached=1 on 72 of 80 cycles.
 */

import { describe, expect, it } from "vitest";

import { PHASE2_DOWNSTREAM_RESERVE_MS, phase1IngestDeadline } from "./source-poll.server";
import { SOURCE_LANE_BUDGET_MS, VENUE_MATCH_RESERVE_MS, sourceIngestDeadline } from "./worker.server";

describe("source ingestion can no longer consume the whole lane budget", () => {
  it("reserves budget for venue matching", () => {
    const laneStart = 1_000_000;
    const ingestCutoff = sourceIngestDeadline(laneStart);
    const laneDeadline = laneStart + SOURCE_LANE_BUDGET_MS;
    expect(ingestCutoff).toBeLessThan(laneDeadline);
    expect(laneDeadline - ingestCutoff).toBe(VENUE_MATCH_RESERVE_MS);
    expect(VENUE_MATCH_RESERVE_MS).toBeGreaterThan(0);
  });

  it("both PMUS and KALSHI lanes still have real time left after ingestion exhausts its own sub-budget", () => {
    const laneStart = 0;
    // Simulates production: ingestion runs right up to (and slightly past) its own cutoff.
    const nowAfterIngest = sourceIngestDeadline(laneStart) + 250;
    const laneDeadline = laneStart + SOURCE_LANE_BUDGET_MS;
    const remainingForBothVenues = laneDeadline - nowAfterIngest;
    // Both venues share this SAME absolute deadline concurrently, so each gets all of it.
    expect(remainingForBothVenues).toBeGreaterThan(5_000);
  });
});

describe("phase 2 downstream drain can no longer be starved by phase 1 ingestion", () => {
  it("phase 1 stops before the poll deadline, leaving the reserve for pending-fill processing", () => {
    const pollDeadline = 500_000;
    // now=0: a comfortably large remaining window, so the fixed reserve applies normally
    // (see phase1IngestDeadline's own doc comment for the small-window clamp case).
    expect(phase1IngestDeadline(pollDeadline, 0)).toBe(pollDeadline - PHASE2_DOWNSTREAM_RESERVE_MS);
    expect(PHASE2_DOWNSTREAM_RESERVE_MS).toBeGreaterThan(0);
  });

  it("an old durable pending fill still has budget after heavy ingestion consumed phase 1's entire sub-budget", () => {
    const pollDeadline = 18_000;
    const phase1Cutoff = phase1IngestDeadline(pollDeadline, 0);
    // Heavy backlog: ingestion runs until its cutoff, then overruns by one in-flight page.
    const nowAfterPhase1 = phase1Cutoff + 300;
    expect(nowAfterPhase1).toBeLessThan(pollDeadline); // phase 2 entry guard does NOT trip
    expect(pollDeadline - nowAfterPhase1).toBeGreaterThan(1_000);
  });

  it("callers with no deadline are unaffected", () => {
    expect(phase1IngestDeadline(Number.POSITIVE_INFINITY, 0)).toBe(Number.POSITIVE_INFINITY);
  });

  it("RECONCILIATION FIX (2026-08-22): a caller whose remaining window is already <= the reserve gets the WHOLE window, not a negative one -- the confirmed defect in the original single-argument version of this function", () => {
    const nowMs = 1_700_000_000_000;
    const pollDeadline = nowMs + 500; // remaining window (500ms) is far smaller than PHASE2_DOWNSTREAM_RESERVE_MS
    expect(phase1IngestDeadline(pollDeadline, nowMs)).toBe(pollDeadline);
  });
});
