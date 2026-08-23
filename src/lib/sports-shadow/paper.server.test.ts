import { describe, expect, it } from "vitest";

import {
  computePaperFillsForObservation,
  maybeDecideExpiredRoutingCutoffs,
  ROUTING_DECISION_CUTOFF_MS,
  type CapturedObservation,
  type LifecycleTrigger,
  type OpenPosition,
  type PaperFillRow,
  type PaperRepository,
  type RoutingProvenance,
  type SignalProvenance,
  type VenueMatchProvenance,
} from "./paper.server";
import type { DepthLevel, Venue } from "./types";

type Key = string;
function key(signalId: string, requestedDelayMs: number, tier: number): Key {
  return `${signalId}:${requestedDelayMs}:${tier}`;
}

/** Mirrors depth-walk.ts's SPORTS_SHADOW_NOTIONALS_USD -- not imported directly to keep this fake self-contained. */
const CANONICAL_TIERS = [5, 10, 25, 50, 100] as const;

/**
 * Simulates the real DB's two-step provenance/finalize protocol (see the migration's own
 * doc comment) in-memory: `provenance` mirrors the durable
 * sports_shadow_paper_fills row's own (pmus_observation_id, kalshi_observation_id,
 * decided_at) tuple, and `decisions` mirrors its decision-time fields, keyed identically.
 */
function fakeRepo(config: {
  observations?: Map<string, CapturedObservation>;
  signalProvenance?: Map<string, SignalProvenance>;
  venueMatches?: Map<string, VenueMatchProvenance>;
  positions?: Map<string, OpenPosition>;
  lifecycleTriggers?: Map<string, LifecycleTrigger>;
} = {}): PaperRepository & { decisions: Map<Key, PaperFillRow>; provenance: Map<Key, RoutingProvenance>; positions: Map<string, OpenPosition> } {
  const observations = config.observations ?? new Map<string, CapturedObservation>();
  const provenance = new Map<Key, RoutingProvenance>();
  const decisions = new Map<Key, PaperFillRow>();
  const positions = config.positions ?? new Map<string, OpenPosition>();
  const lifecycleTriggers = config.lifecycleTriggers ?? new Map<string, LifecycleTrigger>();
  const positionKey = (signalId: string, venue: Venue, tier: number) => `${signalId}:${venue}:${tier}`;
  const lifecycleKey = (signalId: string, requestedDelayMs: number, tier: number, triggerId: string) => `${signalId}:${requestedDelayMs}:${tier}:${triggerId}`;
  const lifecycleDecisions = new Map<string, PaperFillRow>();

  return {
    decisions,
    positions,
    provenance,
    async getObservation(id) {
      return observations.get(id) ?? null;
    },
    async getObservationForVenue(signalId, venue, requestedDelayMs) {
      for (const o of observations.values()) {
        if (o.signalId === signalId && o.venue === venue && o.requestedDelayMs === requestedDelayMs) return o;
      }
      return null;
    },
    async getSignalProvenance(signalId) {
      return config.signalProvenance?.get(signalId) ?? { experimentEpochId: "epoch-1", firstFillId: "fill-default" };
    },
    async getVenueMatch(signalId, venue) {
      return config.venueMatches?.get(`${signalId}:${venue}`) ?? { targetMarketId: `${venue.toLowerCase()}-market`, selectedSide: "YES" };
    },
    async recordRoutingProvenanceLadder(signalId, requestedDelayMs, venue, observationId, fireAtMs) {
      // CODEX P1-2 (round 2): mirrors the real ladder RPC -- ONE call creates/updates ALL
      // canonical tiers atomically, returned in canonical tier order.
      const results: RoutingProvenance[] = [];
      for (const notionalTierUsd of CANONICAL_TIERS) {
        const k = key(signalId, requestedDelayMs, notionalTierUsd);
        const existing = provenance.get(k) ?? { notionalTierUsd, pmusObservationId: null, kalshiObservationId: null, decidedAt: null, fireAtMs };
        const updated: RoutingProvenance = {
          ...existing,
          pmusObservationId: venue === "PMUS" ? (existing.pmusObservationId ?? observationId) : existing.pmusObservationId,
          kalshiObservationId: venue === "KALSHI" ? (existing.kalshiObservationId ?? observationId) : existing.kalshiObservationId,
        };
        provenance.set(k, updated);
        results.push(updated);
      }
      return results;
    },
    async finalizeRoutingDecision(signalId, requestedDelayMs, notionalTierUsd, row, decidedAtMs) {
      const k = key(signalId, requestedDelayMs, notionalTierUsd);
      const existing = provenance.get(k);
      if (existing?.decidedAt) return false; // already decided -- the DB-level guard this mirrors
      provenance.set(k, {
        ...(existing ?? { notionalTierUsd, pmusObservationId: null, kalshiObservationId: null, fireAtMs: decidedAtMs }),
        decidedAt: new Date(decidedAtMs).toISOString(),
      });
      decisions.set(k, row);
      return true;
    },
    async findExpiredPendingRoutingRows(cutoffAtMs, limit) {
      const out: { signalId: string; requestedDelayMs: number; notionalTierUsd: number; pmusObservationId: string | null; kalshiObservationId: string | null }[] = [];
      for (const [k, p] of provenance) {
        if (p.decidedAt !== null || p.fireAtMs > cutoffAtMs) continue;
        const [signalId, delayStr, tierStr] = k.split(":");
        out.push({ signalId: signalId!, requestedDelayMs: Number(delayStr), notionalTierUsd: Number(tierStr), pmusObservationId: p.pmusObservationId, kalshiObservationId: p.kalshiObservationId });
        if (out.length >= limit) break;
      }
      return out;
    },
    async getOpenPosition(signalId, venue, notionalTierUsd) {
      const p = positions.get(positionKey(signalId, venue, notionalTierUsd));
      return p && p.contractsOpen > 0 ? p : null;
    },
    async getLifecycleTrigger(triggerId) {
      return lifecycleTriggers.get(triggerId) ?? null;
    },
    async finalizeLifecycleDecision(signalId, requestedDelayMs, notionalTierUsd, triggerSourceFillId, _observationId, _decidedAtMs, venue, row) {
      const lk = lifecycleKey(signalId, requestedDelayMs, notionalTierUsd, triggerSourceFillId);
      if (lifecycleDecisions.has(lk)) return false; // already decided -- the DB-level guard this mirrors
      lifecycleDecisions.set(lk, row);
      decisions.set(key(signalId, requestedDelayMs, notionalTierUsd), row);

      if (row.fillStatus !== "FULL" && row.fillStatus !== "PARTIAL") return true; // decided, but no position mutation

      const pk = positionKey(signalId, venue, notionalTierUsd);
      const existing = positions.get(pk);
      if (!existing || existing.contractsOpen <= 0) {
        throw new Error(`finalizeLifecycleDecision: ${row.side} requires an existing OPEN position for ${pk}`);
      }
      if (row.side === "ADD") {
        const newContractsOpen = existing.contractsOpen + row.contracts;
        const newAvgEntry = (existing.contractsOpen * (existing.avgEntryPrice ?? 0) + row.contracts * (row.vwap ?? 0)) / newContractsOpen;
        positions.set(pk, { contractsOpen: newContractsOpen, avgEntryPrice: newAvgEntry });
      } else {
        const exitedContracts = Math.min(row.contracts, existing.contractsOpen);
        positions.set(pk, { contractsOpen: Math.max(0, existing.contractsOpen - exitedContracts), avgEntryPrice: existing.avgEntryPrice });
      }
      return true;
    },
  };
}

const GOOD_ASKS: DepthLevel[] = [
  { price: 0.5, size: 1000 },
  { price: 0.52, size: 1000 },
];
const GOOD_BIDS: DepthLevel[] = [
  { price: 0.48, size: 1000 },
  { price: 0.46, size: 1000 },
];

function obs(overrides: Partial<CapturedObservation> = {}): CapturedObservation {
  return {
    id: "obs-1",
    signalId: "sig-1",
    venue: "PMUS",
    requestedDelayMs: 0,
    fireAtMs: 1_700_000_000_000,
    observed: true,
    stale: false,
    errorCode: null,
    askDepth: GOOD_ASKS,
    bidDepth: GOOD_BIDS,
    triggerSourceFillId: null,
    ...overrides,
  };
}

function seedObservations(...list: CapturedObservation[]): Map<string, CapturedObservation> {
  return new Map(list.map((o) => [o.id, o]));
}

describe("CODEX P1-2: computePaperFillsForObservation -- exactly ONE deterministic decision per (signal, delay, tier), never first-callback-wins", () => {
  it("both venues captured (good depth) in ONE observation's own call -- decides immediately using both, exactly 5 decisions", async () => {
    const pmus = obs({ id: "obs-pmus", venue: "PMUS" });
    const kalshi = obs({ id: "obs-kalshi", venue: "KALSHI" });
    const repo = fakeRepo({ observations: seedObservations(pmus, kalshi) });
    const rows = await computePaperFillsForObservation("obs-pmus", { repo, now: () => 1_700_000_000_500 });
    expect(rows).toHaveLength(5);
    expect(repo.decisions.size).toBe(5);
    expect(rows.every((r) => r.cutoffReason === "BOTH_COMPLETE")).toBe(true);
  });

  it("PM-US completes FIRST with Kalshi not yet captured at all -- does NOT decide yet, waits (no premature single-venue decision within the cutoff window)", async () => {
    const pmus = obs({ id: "obs-pmus", venue: "PMUS" });
    const repo = fakeRepo({ observations: seedObservations(pmus) });
    const rows = await computePaperFillsForObservation("obs-pmus", { repo, now: () => pmus.fireAtMs + 1_000 }); // well within the cutoff window
    expect(rows).toHaveLength(0);
    expect(repo.decisions.size).toBe(0);
    // Provenance for PM-US IS recorded, even though nothing decided yet.
    expect(repo.provenance.get(key("sig-1", 0, 5))?.pmusObservationId).toBe("obs-pmus");
    expect(repo.provenance.get(key("sig-1", 0, 5))?.kalshiObservationId).toBeNull();
  });

  it("Kalshi arrives LATER (before cutoff) via its OWN call -- decides then, using BOTH final same-delay observations, exactly once per tier, no duplicate ladder", async () => {
    const pmus = obs({ id: "obs-pmus", venue: "PMUS" });
    const kalshi = obs({ id: "obs-kalshi", venue: "KALSHI", askDepth: [{ price: 0.4, size: 1000 }] }); // better base price, but incomplete net fees fail closed
    // Kalshi's row genuinely does not exist yet at the time of PM-US's own call --
    // the SAME mutable Map is used for both calls, so adding Kalshi's row in between
    // faithfully simulates it "arriving later," not merely being pre-seeded.
    const observations = seedObservations(pmus);
    const repo = fakeRepo({ observations });

    const first = await computePaperFillsForObservation("obs-pmus", { repo, now: () => pmus.fireAtMs + 1_000 });
    expect(first).toHaveLength(0); // PM-US alone does not decide

    observations.set("obs-kalshi", kalshi);
    const second = await computePaperFillsForObservation("obs-kalshi", { repo, now: () => pmus.fireAtMs + 2_000 });
    expect(second).toHaveLength(5); // Kalshi's own call is what triggers the (now-complete) decision
    expect(second.every((r) => r.chosenVenue === "PMUS")).toBe(true); // Kalshi was considered but fails closed on incomplete net fees
    expect(second.every((r) => r.kalshiResult.fee?.valid === false)).toBe(true);
    expect(repo.decisions.size).toBe(5);

    // No duplicate ladder: re-invoking PM-US's own observation again changes nothing.
    const third = await computePaperFillsForObservation("obs-pmus", { repo, now: () => pmus.fireAtMs + 3_000 });
    expect(third).toHaveLength(0);
    expect(repo.decisions.size).toBe(5); // still exactly 5, never 10
  });

  it("no LATER +5 observation can ever alter the +0 decision -- they are entirely separate (signal, delay, tier) keys", async () => {
    const pmusZero = obs({ id: "obs-pmus-0", venue: "PMUS", requestedDelayMs: 0 });
    const kalshiZero = obs({ id: "obs-kalshi-0", venue: "KALSHI", requestedDelayMs: 0 });
    const repo = fakeRepo({ observations: seedObservations(pmusZero, kalshiZero) });
    await computePaperFillsForObservation("obs-pmus-0", { repo, now: () => pmusZero.fireAtMs });
    const zeroDecisionBefore = repo.decisions.get(key("sig-1", 0, 5));
    expect(zeroDecisionBefore).toBeDefined();

    // A completely different delay's observation for the SAME signal.
    const pmusFive = obs({ id: "obs-pmus-5", venue: "PMUS", requestedDelayMs: 5000, fireAtMs: pmusZero.fireAtMs + 5000, askDepth: [{ price: 0.1, size: 1000 }] });
    const repo2 = fakeRepo({ observations: seedObservations(pmusZero, kalshiZero, pmusFive) });
    // Replay the +0 decision into repo2 to simulate "already decided earlier".
    await computePaperFillsForObservation("obs-pmus-0", { repo: repo2, now: () => pmusZero.fireAtMs });
    await computePaperFillsForObservation("obs-pmus-5", { repo: repo2, now: () => pmusFive.fireAtMs + 999_999 }); // past cutoff, decides alone
    const zeroDecisionAfter = repo2.decisions.get(key("sig-1", 0, 5));
    expect(zeroDecisionAfter).toEqual(zeroDecisionBefore); // completely untouched by the +5 event
    expect(repo2.decisions.get(key("sig-1", 5000, 5))).toBeDefined(); // the +5 decision is its own separate row
  });

  it("cutoff expiry: when the sibling never captures and the cutoff window has passed, decides with just the one known venue", async () => {
    const pmus = obs({ id: "obs-pmus", venue: "PMUS" });
    const repo = fakeRepo({ observations: seedObservations(pmus) });
    const rows = await computePaperFillsForObservation("obs-pmus", { repo, now: () => pmus.fireAtMs + ROUTING_DECISION_CUTOFF_MS + 1 });
    expect(rows).toHaveLength(5);
    expect(rows.every((r) => r.chosenVenue === "PMUS")).toBe(true);
    expect(rows.every((r) => r.cutoffReason === "CUTOFF_EXPIRED")).toBe(true);
  });

  it("a stale/failed observation still records provenance (so the sibling's own eventual call can see 'this venue is known and unavailable') even though it produces no usable depth itself", async () => {
    const pmusFailed = obs({ id: "obs-pmus", venue: "PMUS", stale: true });
    const kalshi = obs({ id: "obs-kalshi", venue: "KALSHI" });
    // Kalshi genuinely does not exist yet at the time of PM-US's own call.
    const observations = seedObservations(pmusFailed);
    const repo = fakeRepo({ observations });
    const rows = await computePaperFillsForObservation("obs-pmus", { repo, now: () => pmusFailed.fireAtMs + 100 });
    // PM-US is known (failed); Kalshi genuinely not yet captured -- not decided yet.
    expect(rows).toHaveLength(0);
    expect(repo.provenance.get(key("sig-1", 0, 5))?.pmusObservationId).toBe("obs-pmus");

    observations.set("obs-kalshi", kalshi);
    const second = await computePaperFillsForObservation("obs-kalshi", { repo, now: () => pmusFailed.fireAtMs + 200 });
    expect(second).toHaveLength(5); // now both known -> decides
    expect(second.every((r) => r.chosenVenue === null)).toBe(true); // PM-US failed and Kalshi's incomplete net fee is not routable
    expect(second.every((r) => r.fillStatus === "REJECTED")).toBe(true);
    expect(second.every((r) => r.pmusResult.available === false)).toBe(true);
  });

  it("an observation that does not exist at all produces zero fills without throwing", async () => {
    const repo = fakeRepo();
    const rows = await computePaperFillsForObservation("nonexistent", { repo });
    expect(rows).toHaveLength(0);
  });

  it("CODEX P1-4: the decided row persists direct target_market_id/selected_side provenance from the CHOSEN venue's own match, plus P2-3's source_fill_id/experiment_epoch_id", async () => {
    const pmus = obs({ id: "obs-pmus", venue: "PMUS" });
    const kalshi = obs({ id: "obs-kalshi", venue: "KALSHI" });
    const repo = fakeRepo({
      observations: seedObservations(pmus, kalshi),
      signalProvenance: new Map([["sig-1", { experimentEpochId: "epoch-xyz", firstFillId: "fill-anchor-1" }]]),
      venueMatches: new Map([
        ["sig-1:PMUS", { targetMarketId: "pmus-slug-1", selectedSide: "TEAM:NYY:LONG" }],
        ["sig-1:KALSHI", { targetMarketId: "KXMLB-1", selectedSide: "YES" }],
      ]),
    });
    const rows = await computePaperFillsForObservation("obs-pmus", { repo, now: () => 1_700_000_000_500 });
    for (const r of rows) {
      expect(r.experimentEpochId).toBe("epoch-xyz");
      expect(r.sourceFillId).toBe("fill-anchor-1");
      if (r.chosenVenue === "PMUS") {
        expect(r.targetMarketId).toBe("pmus-slug-1");
        expect(r.selectedSide).toBe("TEAM:NYY:LONG");
      } else if (r.chosenVenue === "KALSHI") {
        expect(r.targetMarketId).toBe("KXMLB-1");
        expect(r.selectedSide).toBe("YES");
      }
    }
  });

  it("Part 11: every persisted fill's fee is populated with a real fee-model version, never fee=0/unversioned", async () => {
    const pmus = obs({ id: "obs-pmus", venue: "PMUS" });
    const repo = fakeRepo({ observations: seedObservations(pmus) });
    const rows = await computePaperFillsForObservation("obs-pmus", { repo, now: () => pmus.fireAtMs + ROUTING_DECISION_CUTOFF_MS + 1 });
    for (const r of rows) {
      expect(r.feeModelVersion).not.toBeNull();
      expect(r.feeUsd).not.toBeNull();
      expect(r.feeUsd).toBeGreaterThan(0);
    }
  });

  it("empty ask depth on the triggering venue rejects when the other venue has only incomplete net fees", async () => {
    const pmusEmpty = obs({ id: "obs-pmus", venue: "PMUS", askDepth: [] });
    const kalshiGood = obs({ id: "obs-kalshi", venue: "KALSHI" });
    const repo = fakeRepo({ observations: seedObservations(pmusEmpty, kalshiGood) });
    const rows = await computePaperFillsForObservation("obs-pmus", { repo, now: () => 1_700_000_000_500 });
    expect(rows.every((r) => r.chosenVenue === null)).toBe(true);
    expect(rows.every((r) => r.rejectReason?.includes("KALSHI fee UNVERIFIED"))).toBe(true);
  });
});

describe("CODEX P1-2: maybeDecideExpiredRoutingCutoffs -- closes the 'sibling never arrives' gap for a venue that was never schedulable at all", () => {
  it("a routing row with only PM-US's provenance ever recorded, past its cutoff window, gets decided by the sweep", async () => {
    const pmus = obs({ id: "obs-pmus", venue: "PMUS" });
    const repo = fakeRepo({ observations: seedObservations(pmus) });
    // Record provenance WITHOUT deciding (simulates being called well before the cutoff).
    await computePaperFillsForObservation("obs-pmus", { repo, now: () => pmus.fireAtMs + 1_000 });
    expect(repo.decisions.size).toBe(0);

    const decidedCount = await maybeDecideExpiredRoutingCutoffs({ repo, now: () => pmus.fireAtMs + ROUTING_DECISION_CUTOFF_MS + 1 });
    expect(decidedCount).toBe(5);
    expect(repo.decisions.size).toBe(5);
    expect([...repo.decisions.values()].every((r) => r.cutoffReason === "CUTOFF_EXPIRED" && r.chosenVenue === "PMUS")).toBe(true);
  });

  it("a row that is not yet past its cutoff window is left untouched by the sweep", async () => {
    const pmus = obs({ id: "obs-pmus", venue: "PMUS" });
    const repo = fakeRepo({ observations: seedObservations(pmus) });
    await computePaperFillsForObservation("obs-pmus", { repo, now: () => pmus.fireAtMs + 1_000 });
    const decidedCount = await maybeDecideExpiredRoutingCutoffs({ repo, now: () => pmus.fireAtMs + 1_500 }); // still well within the cutoff
    expect(decidedCount).toBe(0);
    expect(repo.decisions.size).toBe(0);
  });

  it("an already-decided row is never re-decided by the sweep (idempotent, no-hindsight preserved)", async () => {
    const pmus = obs({ id: "obs-pmus", venue: "PMUS" });
    const kalshi = obs({ id: "obs-kalshi", venue: "KALSHI" });
    const repo = fakeRepo({ observations: seedObservations(pmus, kalshi) });
    await computePaperFillsForObservation("obs-pmus", { repo, now: () => pmus.fireAtMs + 500 });
    expect(repo.decisions.size).toBe(5); // both already known -> decided immediately
    const decidedCount = await maybeDecideExpiredRoutingCutoffs({ repo, now: () => pmus.fireAtMs + ROUTING_DECISION_CUTOFF_MS + 1 });
    expect(decidedCount).toBe(0); // nothing left pending
    expect(repo.decisions.size).toBe(5);
  });
});

describe("CODEX P2-6: computePaperFillsForObservation respects an external deadline -- full-route timing analysis proof", () => {
  it("a deadline already exceeded before the first tier decides ZERO tiers, leaving all five pending for a later trigger (the sibling's own call or the periodic cutoff sweep) -- never a lost or corrupted decision", async () => {
    const pmus = obs({ id: "obs-pmus", venue: "PMUS" });
    const kalshi = obs({ id: "obs-kalshi", venue: "KALSHI" });
    const repo = fakeRepo({ observations: seedObservations(pmus, kalshi) });
    const fixedNow = pmus.fireAtMs + 500;
    const rows = await computePaperFillsForObservation("obs-pmus", { repo, now: () => fixedNow }, fixedNow - 1); // deadline already in the past
    expect(rows).toHaveLength(0);
    expect(repo.decisions.size).toBe(0);
    // Not lost -- a later call (no deadline, or a fresh one) still reaches all 5 tiers.
    const later = await computePaperFillsForObservation("obs-pmus", { repo, now: () => fixedNow + 1 });
    expect(later).toHaveLength(5);
  });

  it("a slow dependency (simulated by a repo call that advances the clock during per-tier decision-making) is interrupted mid-way through the five tiers rather than running unbounded -- proves the P2-6 fix: a backed-up Postgres can no longer extend one observation's onObservationClaimed call past its own deadline uncounted", async () => {
    const pmus = obs({ id: "obs-pmus", venue: "PMUS" });
    const kalshi = obs({ id: "obs-kalshi", venue: "KALSHI" });
    let now = pmus.fireAtMs;
    const deadline = pmus.fireAtMs + 250; // tight -- allows roughly one tier's worth of "slow" round trips
    const repo = fakeRepo({ observations: seedObservations(pmus, kalshi) });
    // CODEX P1-2 (round 2): provenance for all 5 tiers is now created in ONE upfront
    // ladder call, entirely BEFORE the deadline-bound per-tier loop begins -- the
    // deadline can only ever interrupt the per-tier DECISION step (finalizeRoutingDecision
    // and everything decideOneTier does before it), not provenance creation itself.
    const originalFinalize = repo.finalizeRoutingDecision.bind(repo);
    let callCount = 0;
    repo.finalizeRoutingDecision = async (...args) => {
      callCount += 1;
      now += 200; // simulates a slow/backed-up Postgres round trip
      return originalFinalize(...args);
    };
    const rows = await computePaperFillsForObservation("obs-pmus", { repo, now: () => now }, deadline);
    expect(rows.length).toBeLessThan(5); // interrupted -- did NOT decide all 5 tiers unbounded
    expect(callCount).toBeLessThan(10); // bounded, not an unbounded/runaway loop
    // The central P1-2 (round 2) guarantee: every tier -- decided or not -- already has a
    // durable provenance row, created upfront before this loop ever started. A missing DB
    // row can no longer mean a silently missing experiment opportunity.
    expect(repo.provenance.size).toBe(5);
  });

  it("REQUIRED TEST (CODEX P1-2 round 2): one-venue +0 observation, deadline fires after the $5 tier's own decision -- the periodic cutoff sweep still decides all 5 tiers on restart, none disappear", async () => {
    const pmus = obs({ id: "obs-pmus", venue: "PMUS", fireAtMs: 1_700_000_000_000 });
    // No Kalshi observation is ever captured for this (signal, delay) -- the common
    // single-venue-schedulable case Codex's finding specifically names.
    const repo = fakeRepo({ observations: seedObservations(pmus) });
    // No sibling venue is ever captured, so tiers can only ever decide via CUTOFF_EXPIRED
    // -- start already past ROUTING_DECISION_CUTOFF_MS so the per-tier loop actually
    // attempts decisions (rather than waiting) from its very first tier.
    const startNow = pmus.fireAtMs + ROUTING_DECISION_CUTOFF_MS + 1;
    let now = startNow;
    const deadline = startNow + 250; // tight -- allows roughly one tier's own decision before interruption
    const originalFinalize = repo.finalizeRoutingDecision.bind(repo);
    repo.finalizeRoutingDecision = async (...args) => {
      now += 200; // simulates a slow/backed-up Postgres round trip
      return originalFinalize(...args);
    };

    const firstCallRows = await computePaperFillsForObservation("obs-pmus", { repo, now: () => now }, deadline);
    expect(firstCallRows.length).toBeGreaterThan(0);
    expect(firstCallRows.length).toBeLessThan(5); // interrupted before every tier could be decided
    // The core P1-2 (round 2) guarantee that makes recovery possible at all: every tier
    // already has a durable row, even the ones this call never got to decide.
    expect(repo.provenance.size).toBe(5);

    // Simulate a restart well past the cutoff window, with no deadline of its own --
    // exactly what worker.server.ts's onCycleComplete invokes every cycle.
    const laterNow = pmus.fireAtMs + ROUTING_DECISION_CUTOFF_MS + 1_000;
    const decidedBySweep = await maybeDecideExpiredRoutingCutoffs({ repo, now: () => laterNow });

    expect(decidedBySweep).toBe(5 - firstCallRows.length); // exactly the tiers left over
    expect(repo.decisions.size).toBe(5); // ALL FIVE tiers terminally decided -- none disappeared
    expect([...repo.decisions.values()].every((r) => r.chosenVenue === "PMUS" && r.cutoffReason !== undefined)).toBe(true);
  });
});

describe("CODEX P1-3: follower lifecycle -- ADD/EXIT decisions", () => {
  const TIER = 10;

  it("ADD: adds to an existing OPEN position using the source DCA fraction, not a fresh full-tier buy", async () => {
    const repo = fakeRepo({
      positions: new Map([[`sig-1:PMUS:${TIER}`, { contractsOpen: 20, avgEntryPrice: 0.5 }]]),
      lifecycleTriggers: new Map([["trigger-add", { signalId: "sig-1", triggerType: "ADD", trackedShares: 1, exitFraction: null, addFraction: 0.1, price: 0.55, sourceTs: 1_700_000_100 }]]),
      observations: seedObservations(obs({ id: "obs-add", triggerSourceFillId: "trigger-add", askDepth: [{ price: 0.55, size: 1000 }] })),
    });
    const rows = await computePaperFillsForObservation("obs-add", { repo });
    const row = rows.find((r) => r.notionalTierUsd === TIER)!;
    expect(row.side).toBe("ADD");
    expect(row.fillStatus).toBe("FULL");
    const addedContracts = (TIER * 0.1) / 0.55;
    expect(row.contracts).toBeCloseTo(addedContracts, 6);

    const after = repo.positions.get(`sig-1:PMUS:${TIER}`)!;
    expect(after.contractsOpen).toBeCloseTo(20 + addedContracts, 6);
    expect(after.avgEntryPrice).toBeCloseTo((20 * 0.5 + addedContracts * 0.55) / (20 + addedContracts), 6);
  });

  it("ADD is REJECTED (never fabricated) when there is no existing OPEN position for this tier -- nothing to add to", async () => {
    const repo = fakeRepo({
      lifecycleTriggers: new Map([["trigger-add", { signalId: "sig-1", triggerType: "ADD", trackedShares: 10, exitFraction: null, addFraction: 1, price: 0.55, sourceTs: 1_700_000_100 }]]),
      observations: seedObservations(obs({ id: "obs-add", triggerSourceFillId: "trigger-add" })),
    });
    const rows = await computePaperFillsForObservation("obs-add", { repo });
    expect(rows.every((r) => r.notionalTierUsd !== TIER || false)).toBe(true);
    // No open position at all for ANY tier -- every tier is SKIPPED (no logical
    // opportunity), never a fabricated REJECTED row either.
    expect(rows).toHaveLength(0);
  });

  it("EXIT: sells the proportional share of THIS TIER's own contracts_open against BID depth, realizing P&L against avg_entry_price", async () => {
    const repo = fakeRepo({
      positions: new Map([[`sig-1:PMUS:${TIER}`, { contractsOpen: 20, avgEntryPrice: 0.5 }]]),
      lifecycleTriggers: new Map([["trigger-exit", { signalId: "sig-1", triggerType: "EXIT", trackedShares: 5, exitFraction: 0.5, addFraction: null, price: 0.5, sourceTs: 1_700_000_200 }]]),
      observations: seedObservations(obs({ id: "obs-exit", triggerSourceFillId: "trigger-exit", bidDepth: [{ price: 0.6, size: 1000 }] })),
    });
    const rows = await computePaperFillsForObservation("obs-exit", { repo });
    const row = rows.find((r) => r.notionalTierUsd === TIER)!;
    expect(row.side).toBe("EXIT");
    expect(row.fillStatus).toBe("FULL");
    expect(row.contracts).toBeCloseTo(10, 6); // 20 * 0.5 exitFraction
    expect(row.vwap).toBeCloseTo(0.6, 6);

    const after = repo.positions.get(`sig-1:PMUS:${TIER}`)!;
    expect(after.contractsOpen).toBeCloseTo(10, 6); // 20 - 10 exited

    // allInCostUsd on an EXIT row holds NET PROCEEDS (proceeds minus fee) -- realized
    // P&L = net proceeds - cost basis (exited contracts * avg_entry_price).
    const proceeds = 10 * 0.6;
    const costBasis = 10 * 0.5;
    expect(row.allInCostUsd).toBeCloseTo(proceeds - row.feeUsd!, 6);
    expect(row.allInCostUsd! - costBasis).toBeGreaterThan(0); // profitable exit (sold above entry)
  });

  it("a FULL exit (exitFraction=1) drains contracts_open to exactly zero, leaving no open position for a later tier check", async () => {
    const repo = fakeRepo({
      positions: new Map([[`sig-1:PMUS:${TIER}`, { contractsOpen: 20, avgEntryPrice: 0.5 }]]),
      lifecycleTriggers: new Map([["trigger-exit-full", { signalId: "sig-1", triggerType: "EXIT", trackedShares: 20, exitFraction: 1, addFraction: null, price: 0.5, sourceTs: 1_700_000_300 }]]),
      observations: seedObservations(obs({ id: "obs-exit-full", triggerSourceFillId: "trigger-exit-full", bidDepth: [{ price: 0.5, size: 1000 }] })),
    });
    await computePaperFillsForObservation("obs-exit-full", { repo });
    const position = await repo.getOpenPosition("sig-1", "PMUS", TIER);
    expect(position).toBeNull(); // fully closed
  });

  it("restart idempotency: re-running the SAME captured lifecycle observation never double-applies the position mutation", async () => {
    const repo = fakeRepo({
      positions: new Map([[`sig-1:PMUS:${TIER}`, { contractsOpen: 20, avgEntryPrice: 0.5 }]]),
      lifecycleTriggers: new Map([["trigger-exit", { signalId: "sig-1", triggerType: "EXIT", trackedShares: 5, exitFraction: 0.5, addFraction: null, price: 0.5, sourceTs: 1_700_000_200 }]]),
      observations: seedObservations(obs({ id: "obs-exit", triggerSourceFillId: "trigger-exit", bidDepth: [{ price: 0.5, size: 1000 }] })),
    });
    const first = await computePaperFillsForObservation("obs-exit", { repo });
    expect(first).toHaveLength(1); // only TIER has an open position -- the other 4 tiers are SKIPPED (no logical opportunity), never decided at all
    const afterFirst = { ...repo.positions.get(`sig-1:PMUS:${TIER}`)! };

    const second = await computePaperFillsForObservation("obs-exit", { repo });
    expect(second).toHaveLength(0); // already decided for every tier that had one -- no-op
    expect(repo.positions.get(`sig-1:PMUS:${TIER}`)).toEqual(afterFirst); // NOT double-exited
  });

  it("REQUIRED INTEGRATION TEST: source BUY -> DCA BUY -> partial SELL -> full SELL is followed as ENTRY -> ADD -> partial EXIT -> full EXIT, with correct inventory, realized economics, and restart idempotency, across an isolated OTHER tier", async () => {
    const OTHER_TIER = 25;
    const repo = fakeRepo({
      // ENTRY already happened (out of scope for this test -- simulates its result directly).
      positions: new Map([
        [`sig-1:PMUS:${TIER}`, { contractsOpen: 20, avgEntryPrice: 0.5 }],
        [`sig-1:PMUS:${OTHER_TIER}`, { contractsOpen: 50, avgEntryPrice: 0.5 }],
      ]),
      lifecycleTriggers: new Map([
        ["trigger-add", { signalId: "sig-1", triggerType: "ADD", trackedShares: 10, exitFraction: null, addFraction: 0.5, price: 0.55, sourceTs: 1_700_000_100 }],
        ["trigger-exit-partial", { signalId: "sig-1", triggerType: "EXIT", trackedShares: 5, exitFraction: 0.5, addFraction: null, price: 0.5, sourceTs: 1_700_000_200 }],
        ["trigger-exit-full", { signalId: "sig-1", triggerType: "EXIT", trackedShares: 5, exitFraction: 1, addFraction: null, price: 0.45, sourceTs: 1_700_000_300 }],
      ]),
      observations: seedObservations(
        obs({ id: "obs-add", triggerSourceFillId: "trigger-add", askDepth: [{ price: 0.55, size: 1000 }] }),
        obs({ id: "obs-exit-partial", triggerSourceFillId: "trigger-exit-partial", bidDepth: [{ price: 0.5, size: 1000 }] }),
        obs({ id: "obs-exit-full", triggerSourceFillId: "trigger-exit-full", bidDepth: [{ price: 0.45, size: 1000 }] }),
      ),
    });

    // ADD -- both tiers get their own independent ADD (isolated: TIER and OTHER_TIER
    // never share state), scaled by the source DCA fraction.
    const addRows = await computePaperFillsForObservation("obs-add", { repo });
    const addTier = addRows.find((r) => r.notionalTierUsd === TIER)!;
    const addOtherTier = addRows.find((r) => r.notionalTierUsd === OTHER_TIER)!;
    expect(addTier.side).toBe("ADD");
    expect(addOtherTier.side).toBe("ADD");
    const addedContractsTier = (TIER * 0.5) / 0.55;
    const addedContractsOtherTier = (OTHER_TIER * 0.5) / 0.55;
    expect(repo.positions.get(`sig-1:PMUS:${TIER}`)!.contractsOpen).toBeCloseTo(20 + addedContractsTier, 6);
    expect(repo.positions.get(`sig-1:PMUS:${OTHER_TIER}`)!.contractsOpen).toBeCloseTo(50 + addedContractsOtherTier, 6);

    // Partial EXIT -- proportional to THIS TIER's own remaining inventory, independently per tier.
    const beforePartialExitTier = repo.positions.get(`sig-1:PMUS:${TIER}`)!.contractsOpen;
    const beforePartialExitOtherTier = repo.positions.get(`sig-1:PMUS:${OTHER_TIER}`)!.contractsOpen;
    const exitPartialRows = await computePaperFillsForObservation("obs-exit-partial", { repo });
    const exitPartialTier = exitPartialRows.find((r) => r.notionalTierUsd === TIER)!;
    expect(exitPartialTier.side).toBe("EXIT");
    expect(exitPartialTier.contracts).toBeCloseTo(beforePartialExitTier * 0.5, 6);
    expect(repo.positions.get(`sig-1:PMUS:${TIER}`)!.contractsOpen).toBeCloseTo(beforePartialExitTier * 0.5, 6);
    expect(repo.positions.get(`sig-1:PMUS:${OTHER_TIER}`)!.contractsOpen).toBeCloseTo(beforePartialExitOtherTier * 0.5, 6);

    // Idempotency check BEFORE fully closing -- proves the decide-once guard itself,
    // not merely "nothing left to exit."
    const afterPartialSnapshot = { ...repo.positions.get(`sig-1:PMUS:${TIER}`)! };
    const retryPartial = await computePaperFillsForObservation("obs-exit-partial", { repo });
    expect(retryPartial).toHaveLength(0);
    expect(repo.positions.get(`sig-1:PMUS:${TIER}`)).toEqual(afterPartialSnapshot);

    // Full EXIT -- a full source sell (exitFraction=1) drains EVERY tier's own
    // remaining inventory to exactly zero, independently (each tier computes its own
    // requestedContracts from its OWN contracts_open -- never a shared/global amount).
    await computePaperFillsForObservation("obs-exit-full", { repo });
    expect(await repo.getOpenPosition("sig-1", "PMUS", TIER)).toBeNull();
    expect(await repo.getOpenPosition("sig-1", "PMUS", OTHER_TIER)).toBeNull();
  });
});
