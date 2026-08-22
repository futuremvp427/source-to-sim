import { describe, expect, it } from "vitest";

import { computePaperFillsForObservation, type CapturedObservation, type PaperFillRow, type PaperRepository } from "./paper.server";
import type { DepthLevel } from "./types";

function fakeRepo(observations: Map<string, CapturedObservation>): PaperRepository & { inserted: PaperFillRow[][] } {
  const inserted: PaperFillRow[][] = [];
  return {
    inserted,
    async getObservation(id) {
      return observations.get(id) ?? null;
    },
    async getSiblingObservation(signalId, venue, requestedDelayMs) {
      for (const obs of observations.values()) {
        if (obs.signalId === signalId && obs.venue === venue && obs.requestedDelayMs === requestedDelayMs) return obs;
      }
      return null;
    },
    async insertPaperFills(rows) {
      inserted.push(rows);
    },
  };
}

const GOOD_ASKS: DepthLevel[] = [
  { price: 0.5, size: 1000 },
  { price: 0.52, size: 1000 },
];

function obs(overrides: Partial<CapturedObservation> = {}): CapturedObservation {
  return {
    id: "obs-1",
    signalId: "sig-1",
    venue: "PMUS",
    requestedDelayMs: 0,
    stale: false,
    errorCode: null,
    askDepth: GOOD_ASKS,
    ...overrides,
  };
}

describe("FINAL BUILD Parts 9/10/12/13: computePaperFillsForObservation", () => {
  it("produces exactly 5 paper-fill rows (one per notional tier) when both venues have good, captured depth", async () => {
    const pmus = obs({ id: "obs-pmus", venue: "PMUS" });
    const kalshi = obs({ id: "obs-kalshi", venue: "KALSHI" });
    const repo = fakeRepo(new Map([["obs-pmus", pmus], ["obs-kalshi", kalshi]]));
    const rows = await computePaperFillsForObservation("obs-pmus", { repo, now: () => 1_700_000_000_000 });
    expect(rows).toHaveLength(5); // $5/$10/$25/$50/$100
    expect(rows.every((r) => r.chosenVenue !== null)).toBe(true);
    expect(repo.inserted).toHaveLength(1);
  });

  it("Section 13: a stale observation produces ZERO paper fills -- never converts missing/stale data into a fabricated fill", async () => {
    const repo = fakeRepo(new Map([["obs-1", obs({ stale: true })]]));
    const rows = await computePaperFillsForObservation("obs-1", { repo });
    expect(rows).toHaveLength(0);
    expect(repo.inserted).toHaveLength(0);
  });

  it("Section 13: a genuinely-failed observation (errorCode set) produces ZERO paper fills", async () => {
    const repo = fakeRepo(new Map([["obs-1", obs({ errorCode: "HTTP_500" })]]));
    const rows = await computePaperFillsForObservation("obs-1", { repo });
    expect(rows).toHaveLength(0);
  });

  it("an observation that does not exist at all produces zero fills without throwing", async () => {
    const repo = fakeRepo(new Map());
    const rows = await computePaperFillsForObservation("nonexistent", { repo });
    expect(rows).toHaveLength(0);
  });

  it("when the sibling venue has not yet captured (still pending), this venue's own fills still route -- single-venue-available path, not blocked by the other", async () => {
    const pmus = obs({ id: "obs-pmus", venue: "PMUS" });
    // No Kalshi observation registered at all -- simulates "still pending."
    const repo = fakeRepo(new Map([["obs-pmus", pmus]]));
    const rows = await computePaperFillsForObservation("obs-pmus", { repo });
    expect(rows).toHaveLength(5);
    expect(rows.every((r) => r.chosenVenue === "PMUS")).toBe(true);
    expect(rows.every((r) => r.kalshiResult.available === false)).toBe(true);
  });

  it("when the sibling venue captured but with a stale/failed result, it is treated as unavailable for routing, not as a bad Kalshi execution", async () => {
    const pmus = obs({ id: "obs-pmus", venue: "PMUS" });
    const kalshiFailed = obs({ id: "obs-kalshi", venue: "KALSHI", errorCode: "HTTP_401" });
    const repo = fakeRepo(new Map([["obs-pmus", pmus], ["obs-kalshi", kalshiFailed]]));
    const rows = await computePaperFillsForObservation("obs-pmus", { repo });
    expect(rows.every((r) => r.kalshiResult.available === false)).toBe(true);
    expect(rows.every((r) => r.chosenVenue === "PMUS")).toBe(true);
  });

  it("Part 11: every persisted fill's fee is populated with a real fee-model version, never fee=0/unversioned", async () => {
    const pmus = obs({ id: "obs-pmus", venue: "PMUS" });
    const repo = fakeRepo(new Map([["obs-pmus", pmus]]));
    const rows = await computePaperFillsForObservation("obs-pmus", { repo });
    for (const r of rows) {
      expect(r.feeModelVersion).not.toBeNull();
      expect(r.feeUsd).not.toBeNull();
      expect(r.feeUsd).toBeGreaterThan(0);
    }
  });

  it("empty ask depth on the triggering venue results in NONE fills, routed to the OTHER venue if it qualifies", async () => {
    const pmusEmpty = obs({ id: "obs-pmus", venue: "PMUS", askDepth: [] });
    const kalshiGood = obs({ id: "obs-kalshi", venue: "KALSHI" });
    const repo = fakeRepo(new Map([["obs-pmus", pmusEmpty], ["obs-kalshi", kalshiGood]]));
    const rows = await computePaperFillsForObservation("obs-pmus", { repo });
    expect(rows.every((r) => r.chosenVenue === "KALSHI")).toBe(true);
  });

  it("routing decision uses the caller-injected clock, never a real timestamp -- deterministic, no-hindsight", async () => {
    const pmus = obs({ id: "obs-pmus", venue: "PMUS" });
    const repo = fakeRepo(new Map([["obs-pmus", pmus]]));
    const rows = await computePaperFillsForObservation("obs-pmus", { repo, now: () => 42 });
    expect(rows.every((r) => r.routingTimestampMs === 42)).toBe(true);
  });
});
