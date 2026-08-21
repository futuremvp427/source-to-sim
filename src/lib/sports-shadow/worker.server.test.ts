import { readFileSync } from "node:fs";

import { describe, expect, it, vi } from "vitest";

import type { SportsShadowConfig } from "./config";
import type { PmusCandidate } from "./pmus";
import type { KalshiCandidate } from "./kalshi";
import type { VenueMatchResult } from "./resolver";
import type { SportsLease, SportsLeaseRepository } from "./sports-lease.server";
import type { WalletPollResult } from "./source-poll.server";
import type { SignalRow } from "./worker";
import type { Venue } from "./types";
import {
  FINAL_OBSERVATION_STAGE_DEADLINE_MS_FOR_TEST,
  OBSERVATION_LEASE_TTL_SECONDS,
  OBSERVATION_LOCK_ID,
  OBSERVATION_STAGE_DEADLINE_MS,
  SOURCE_LOCK_ID,
  runSportsShadowCycle,
  type SportsShadowWorkerDeps,
  type WorkerRepository,
} from "./worker.server";

const WALLET_A = "0xa71093cafc0c099b4ccab24c3cb8018d817923c4";
const WALLET_B = "0x32ed517a571c01b6e9adecf61ba81ca48ff2f960";

function enabledConfig(overrides: Partial<SportsShadowConfig> = {}): SportsShadowConfig {
  return { enabled: true, wallets: [WALLET_A], goLiveAtMs: 1_700_000_000_000, ...overrides };
}

/** In-memory lease repo mirroring the real RPC's CAS semantics (shared shape with sports-lease.server.test.ts's fake). */
function makeFakeLeaseRepo() {
  const rows = new Map<string, { workerId: string; fence: number; expiresAtMs: number }>();
  const acquireCalls: string[] = [];
  const repo: SportsLeaseRepository = {
    async acquire(lockId, workerId, leaseSeconds) {
      acquireCalls.push(lockId);
      const existing = rows.get(lockId);
      const claimable = !existing || existing.expiresAtMs <= Date.now();
      if (!claimable) return null;
      const fence = (existing?.fence ?? 0) + 1;
      rows.set(lockId, { workerId, fence, expiresAtMs: Date.now() + leaseSeconds * 1000 });
      return fence;
    },
    async release(lease) {
      const existing = rows.get(lease.lockId);
      if (!existing || existing.fence !== lease.fence || existing.workerId !== lease.workerId) return;
      rows.set(lease.lockId, { ...existing, expiresAtMs: Date.now() - 1 }); // immediate release
    },
  };
  return { repo, rows, acquireCalls };
}

function signalRow(overrides: Partial<SignalRow> = {}): SignalRow {
  return {
    id: "sig-1",
    createdAtIso: "2026-08-19T00:00:00.000Z",
    sourceFirstFillAtIso: "2026-08-18T23:55:00.000Z",
    wallet: WALLET_A,
    conditionId: "0xcondition-1",
    asset: "0xasset-1",
    betType: "MONEYLINE",
    awayTeam: "NYY",
    homeTeam: "BAL",
    scheduledStartAt: "2026-08-19T22:35:00Z",
    line: null,
    selectedOutcomeRaw: "New York Yankees",
    eventSlug: "mlb-nyy-bal-2026-08-19",
    marketSlug: "mlb-nyy-bal-2026-08-19",
    ...overrides,
  };
}

type ExistingMatchRow = { signalId: string; venue: Venue };

/**
 * Mirrors find_pending_sports_shadow_signals' EXACT SQL semantics (see
 * supabase/migrations/20260820230000_sports_shadow_pending_signals_rpc.sql): a LEFT
 * JOIN anti-join per venue (never a fixed-size historical-prefix scan), ORDER BY
 * (created_at ASC, id ASC), LIMIT clamped to [0, 100] with a NULL-safe default of 20.
 * This is the reference implementation the Task 11B regression suite (see the
 * "find_pending_sports_shadow_signals RPC semantics" describe block) validates against,
 * standing in for the real-Postgres validation this environment could not perform (no
 * cached postgres:17 image, and pulling one was out of scope per the mission).
 */
function makeFakeWorkerRepo(signals: SignalRow[], matches: ExistingMatchRow[]): WorkerRepository {
  return {
    async findPendingSignals(limit: number) {
      const matchedVenuesBySignal = new Map<string, Set<Venue>>();
      for (const m of matches) {
        const set = matchedVenuesBySignal.get(m.signalId) ?? new Set<Venue>();
        set.add(m.venue);
        matchedVenuesBySignal.set(m.signalId, set);
      }
      const clampedLimit = Math.min(Math.max(limit ?? 20, 0), 100);
      const sorted = [...signals].sort((a, b) => a.createdAtIso.localeCompare(b.createdAtIso) || a.id.localeCompare(b.id));
      const pending = sorted
        .map((s) => {
          const venues = matchedVenuesBySignal.get(s.id) ?? new Set<Venue>();
          return { ...s, missingPmus: !venues.has("PMUS"), missingKalshi: !venues.has("KALSHI") };
        })
        .filter((s) => s.missingPmus || s.missingKalshi);
      return pending.slice(0, clampedLimit);
    },
  };
}

function emptyWalletResult(wallet: string, overrides: Partial<WalletPollResult> = {}): WalletPollResult {
  return {
    wallet,
    isBootstrap: false,
    pagesFetched: 1,
    rowsFetched: 0,
    newRows: 0,
    duplicateRows: 0,
    invalidRows: 0,
    metadataFetchFailures: 0,
    ineligibleRows: 0,
    unverifiedRows: 0,
    suppressedPreGoLive: 0,
    newSignals: [],
    aggregatedCount: 0,
    sellRecordedCount: 0,
    lateReconciliationCount: 0,
    backlogTruncated: false,
    error: null,
    ...overrides,
  };
}

function emptyObservationCollectionResult() {
  return { captured: 0, failed: 0, skipped: 0 };
}

function baseDeps(overrides: Partial<SportsShadowWorkerDeps> = {}): Partial<SportsShadowWorkerDeps> {
  const { repo: leaseRepo } = makeFakeLeaseRepo();
  return {
    leaseRepo,
    workerRepo: makeFakeWorkerRepo([], []),
    pollSportsShadowWallet: vi.fn(async (wallet: string) => emptyWalletResult(wallet)) as unknown as SportsShadowWorkerDeps["pollSportsShadowWallet"],
    takeDueSportsShadowObservations: vi.fn(async () => emptyObservationCollectionResult()) as unknown as SportsShadowWorkerDeps["takeDueSportsShadowObservations"],
    discoverPmus: vi.fn(async () => [] as PmusCandidate[]),
    discoverKalshi: vi.fn(async () => [] as KalshiCandidate[]),
    persistVenueMatch: vi.fn(async () => ({ matchId: "match-1", scheduled: 0, downgradeSkipped: false })) as unknown as SportsShadowWorkerDeps["persistVenueMatch"],
    now: () => 1_700_000_100_000,
    ...overrides,
  };
}

describe("runSportsShadowCycle — disabled config", () => {
  it("4. performs no source work and no observation work when disabled", async () => {
    const pollSportsShadowWallet = vi.fn();
    const takeDueSportsShadowObservations = vi.fn();
    const summary = await runSportsShadowCycle(
      { enabled: false, wallets: [], goLiveAtMs: null },
      baseDeps({ pollSportsShadowWallet: pollSportsShadowWallet as never, takeDueSportsShadowObservations: takeDueSportsShadowObservations as never }),
    );
    expect(summary.configEnabled).toBe(false);
    expect(summary.sourceLane).toBeNull();
    expect(pollSportsShadowWallet).not.toHaveBeenCalled();
    expect(takeDueSportsShadowObservations).not.toHaveBeenCalled();
  });
});

describe("runSportsShadowCycle — lane ordering and independence", () => {
  it("7. observation lane executes before source lane", async () => {
    const order: string[] = [];
    const deps = baseDeps({
      takeDueSportsShadowObservations: vi.fn(async () => {
        order.push("observation");
        return emptyObservationCollectionResult();
      }) as unknown as SportsShadowWorkerDeps["takeDueSportsShadowObservations"],
      pollSportsShadowWallet: vi.fn(async (wallet: string) => {
        order.push("source");
        return emptyWalletResult(wallet);
      }) as unknown as SportsShadowWorkerDeps["pollSportsShadowWallet"],
    });
    await runSportsShadowCycle(enabledConfig(), deps);
    expect(order[0]).toBe("observation");
    expect(order).toContain("source");
  });

  it("8. source lease already held by another invocation does NOT prevent the observation lane from running", async () => {
    const { repo: leaseRepo } = makeFakeLeaseRepo();
    // Pre-hold the SOURCE lock only.
    await leaseRepo.acquire(SOURCE_LOCK_ID, "other-invocation", 60);
    const takeDueSportsShadowObservations = vi.fn(async () => emptyObservationCollectionResult());
    const summary = await runSportsShadowCycle(enabledConfig(), baseDeps({ leaseRepo, takeDueSportsShadowObservations: takeDueSportsShadowObservations as never }));
    expect(summary.observationLane.acquired).toBe(true);
    expect(summary.sourceLane?.acquired).toBe(false);
    expect(takeDueSportsShadowObservations).toHaveBeenCalled();
  });

  it("9. observation lease already held does not corrupt or block independent source lease acquisition", async () => {
    const { repo: leaseRepo } = makeFakeLeaseRepo();
    await leaseRepo.acquire(OBSERVATION_LOCK_ID, "other-invocation", 90);
    const pollSportsShadowWallet = vi.fn(async (wallet: string) => emptyWalletResult(wallet));
    const summary = await runSportsShadowCycle(enabledConfig(), baseDeps({ leaseRepo, pollSportsShadowWallet: pollSportsShadowWallet as never }));
    expect(summary.observationLane.acquired).toBe(false);
    expect(summary.sourceLane?.acquired).toBe(true);
    expect(pollSportsShadowWallet).toHaveBeenCalled();
  });

  it("10. of two overlapping cycle invocations sharing one lease repo, only one acquires the source lock at a time", async () => {
    const { repo: leaseRepo, acquireCalls } = makeFakeLeaseRepo();
    // Simulate "overlap" by holding the source lock before a second cycle starts.
    const held = await leaseRepo.acquire(SOURCE_LOCK_ID, "invocation-1", 60);
    expect(held).not.toBeNull();
    const summary = await runSportsShadowCycle(enabledConfig(), baseDeps({ leaseRepo }));
    expect(summary.sourceLane?.acquired).toBe(false);
    expect(acquireCalls.filter((id) => id === SOURCE_LOCK_ID).length).toBeGreaterThanOrEqual(2); // invocation-1's hold + this cycle's failed attempt
  });
});

describe("runSportsShadowCycle — wallet polling", () => {
  it("12. source poll is called exactly once per configured wallet, deterministically", async () => {
    const calls: string[] = [];
    const pollSportsShadowWallet = vi.fn(async (wallet: string) => {
      calls.push(wallet);
      return emptyWalletResult(wallet);
    });
    await runSportsShadowCycle(enabledConfig({ wallets: [WALLET_A, WALLET_B] }), baseDeps({ pollSportsShadowWallet: pollSportsShadowWallet as never }));
    expect(calls).toEqual([WALLET_A, WALLET_B]);
  });

  it("one bad wallet does not prevent the next wallet from being attempted", async () => {
    const pollSportsShadowWallet = vi.fn(async (wallet: string) => {
      if (wallet === WALLET_A) throw new Error("network exploded");
      return emptyWalletResult(wallet);
    });
    const summary = await runSportsShadowCycle(enabledConfig({ wallets: [WALLET_A, WALLET_B] }), baseDeps({ pollSportsShadowWallet: pollSportsShadowWallet as never }));
    expect(summary.sourceLane?.walletSummaries).toHaveLength(2);
    expect(summary.sourceLane?.walletSummaries[1]?.wallet).toBe(WALLET_B);
  });

  it("26. Task 10's backlogTruncated is surfaced in the wallet summary, not hidden", async () => {
    const pollSportsShadowWallet = vi.fn(async (wallet: string) => emptyWalletResult(wallet, { backlogTruncated: true }));
    const summary = await runSportsShadowCycle(enabledConfig(), baseDeps({ pollSportsShadowWallet: pollSportsShadowWallet as never }));
    expect(summary.sourceLane?.walletSummaries[0]?.backlogTruncated).toBe(true);
  });
});

describe("runSportsShadowCycle — durable pending-signal recovery (crash-recovery hard gate)", () => {
  it("13. a signal persisted by a PRIOR invocation and orphaned before resolution is recovered even when this cycle's newlyCreatedSignals is empty", async () => {
    // pollSportsShadowWallet returns ZERO newSignals this cycle (simulating: the source
    // fill is now a duplicate because it was already durably persisted before a crash).
    const pollSportsShadowWallet = vi.fn(async (wallet: string) => emptyWalletResult(wallet, { newSignals: [] }));
    const workerRepo = makeFakeWorkerRepo([signalRow({ id: "orphaned-signal" })], []); // exists durably, zero match rows
    const persistVenueMatch = vi.fn(async (_signalId: string, _result: VenueMatchResult, _detectedAtMs: number, _sourceTimestampIso: string) => ({ matchId: "m1", scheduled: 0, downgradeSkipped: false }));

    const summary = await runSportsShadowCycle(
      enabledConfig(),
      baseDeps({ pollSportsShadowWallet: pollSportsShadowWallet as never, workerRepo, persistVenueMatch: persistVenueMatch as never }),
    );

    expect(summary.sourceLane?.newSignalsCreated).toBe(0);
    expect(summary.sourceLane?.pendingFound).toBe(1);
    expect(summary.sourceLane?.pendingProcessed).toBe(1);
    expect(persistVenueMatch).toHaveBeenCalledWith("orphaned-signal", expect.anything(), expect.anything(), expect.anything(), expect.anything());
  });

  it("14. a signal with PMUS already persisted retries only Kalshi", async () => {
    const workerRepo = makeFakeWorkerRepo([signalRow()], [{ signalId: "sig-1", venue: "PMUS" }]);
    const persistVenueMatch = vi.fn(async (_signalId: string, _result: VenueMatchResult, _detectedAtMs: number, _sourceTimestampIso: string) => ({ matchId: "m1", scheduled: 0, downgradeSkipped: false }));
    const discoverPmus = vi.fn(async () => [] as PmusCandidate[]);
    const discoverKalshi = vi.fn(async () => [] as KalshiCandidate[]);
    const summary = await runSportsShadowCycle(
      enabledConfig(),
      baseDeps({ workerRepo, persistVenueMatch: persistVenueMatch as never, discoverPmus, discoverKalshi }),
    );
    expect(discoverPmus).not.toHaveBeenCalled();
    expect(discoverKalshi).toHaveBeenCalledTimes(1);
    expect(summary.sourceLane?.pmus.attempted).toBe(0);
    expect(summary.sourceLane?.kalshi.attempted).toBe(1);
  });

  it("15. a signal with Kalshi already persisted retries only PMUS", async () => {
    const workerRepo = makeFakeWorkerRepo([signalRow()], [{ signalId: "sig-1", venue: "KALSHI" }]);
    const discoverPmus = vi.fn(async () => [] as PmusCandidate[]);
    const discoverKalshi = vi.fn(async () => [] as KalshiCandidate[]);
    const summary = await runSportsShadowCycle(enabledConfig(), baseDeps({ workerRepo, discoverPmus, discoverKalshi }));
    expect(discoverKalshi).not.toHaveBeenCalled();
    expect(discoverPmus).toHaveBeenCalledTimes(1);
    expect(summary.sourceLane?.pmus.attempted).toBe(1);
    expect(summary.sourceLane?.kalshi.attempted).toBe(0);
  });

  it("25. a bounded pending-signal batch leaves excess work durable for a future cycle", async () => {
    const many = Array.from({ length: 25 }, (_, i) => signalRow({ id: `sig-${i}`, createdAtIso: `2026-08-19T00:${String(i).padStart(2, "0")}:00.000Z` }));
    const workerRepo = makeFakeWorkerRepo(many, []);
    const summary = await runSportsShadowCycle(enabledConfig(), baseDeps({ workerRepo }));
    expect(summary.sourceLane?.pendingFound).toBeLessThan(25); // capped at PENDING_BATCH_SIZE (20)
    expect(summary.sourceLane?.pendingRemainingHint).toBe(true);
  });
});

describe("find_pending_sports_shadow_signals RPC semantics (Task 11B starvation fix)", () => {
  function idOf(i: number): string {
    return `sig-${String(i).padStart(4, "0")}`;
  }
  function ts(minuteOffset: number): string {
    const base = Date.parse("2026-08-01T00:00:00.000Z");
    return new Date(base + minuteOffset * 60_000).toISOString();
  }

  it("1. 220 signals, 1-200 fully resolved, 201 unresolved => signal 201 is returned (the confirmed starvation scenario)", async () => {
    const signals = Array.from({ length: 220 }, (_, i) => signalRow({ id: idOf(i), createdAtIso: ts(i) }));
    const matches: ExistingMatchRow[] = [];
    for (let i = 0; i < 200; i += 1) {
      matches.push({ signalId: idOf(i), venue: "PMUS" }, { signalId: idOf(i), venue: "KALSHI" }); // fully resolved
    }
    // signal 200 (0-indexed) is left unresolved, matching "signal 201" in the mission's 1-indexed framing.
    const workerRepo = makeFakeWorkerRepo(signals, matches);
    const pending = await workerRepo.findPendingSignals(20);
    expect(pending.map((p) => p.id)).toContain(idOf(200));
    expect(pending[0]?.id).toBe(idOf(200)); // globally oldest pending, not silently absent
  });

  it("2. unresolved rows scattered above and below index 200 => the globally oldest unresolved one wins, regardless of position", async () => {
    const signals = Array.from({ length: 300 }, (_, i) => signalRow({ id: idOf(i), createdAtIso: ts(i) }));
    const matches: ExistingMatchRow[] = [];
    for (let i = 0; i < 300; i += 1) {
      if (i === 50 || i === 250) continue; // leave these two unresolved; everything else fully resolved
      matches.push({ signalId: idOf(i), venue: "PMUS" }, { signalId: idOf(i), venue: "KALSHI" });
    }
    const workerRepo = makeFakeWorkerRepo(signals, matches);
    const pending = await workerRepo.findPendingSignals(20);
    expect(pending.map((p) => p.id)).toEqual([idOf(50), idOf(250)]);
  });

  it("3. a signal missing PMUS only is returned with missingPmus=true, missingKalshi=false", async () => {
    const workerRepo = makeFakeWorkerRepo([signalRow()], [{ signalId: "sig-1", venue: "KALSHI" }]);
    const pending = await workerRepo.findPendingSignals(20);
    expect(pending).toEqual([expect.objectContaining({ id: "sig-1", missingPmus: true, missingKalshi: false })]);
  });

  it("4. a signal missing Kalshi only is returned with missingPmus=false, missingKalshi=true", async () => {
    const workerRepo = makeFakeWorkerRepo([signalRow()], [{ signalId: "sig-1", venue: "PMUS" }]);
    const pending = await workerRepo.findPendingSignals(20);
    expect(pending).toEqual([expect.objectContaining({ id: "sig-1", missingPmus: false, missingKalshi: true })]);
  });

  it("5. a signal missing both venues is returned with missingPmus=true, missingKalshi=true", async () => {
    const workerRepo = makeFakeWorkerRepo([signalRow()], []);
    const pending = await workerRepo.findPendingSignals(20);
    expect(pending).toEqual([expect.objectContaining({ id: "sig-1", missingPmus: true, missingKalshi: true })]);
  });

  it("6. a fully resolved signal (both venues matched) is excluded entirely", async () => {
    const workerRepo = makeFakeWorkerRepo([signalRow()], [{ signalId: "sig-1", venue: "PMUS" }, { signalId: "sig-1", venue: "KALSHI" }]);
    const pending = await workerRepo.findPendingSignals(20);
    expect(pending).toHaveLength(0);
  });

  it("7. more pending signals than the batch size => exactly the bounded, deterministic, oldest batch", async () => {
    const signals = Array.from({ length: 50 }, (_, i) => signalRow({ id: idOf(i), createdAtIso: ts(i) }));
    const workerRepo = makeFakeWorkerRepo(signals, []); // none resolved -- all 50 pending
    const pending = await workerRepo.findPendingSignals(20);
    expect(pending).toHaveLength(20);
    expect(pending.map((p) => p.id)).toEqual(Array.from({ length: 20 }, (_, i) => idOf(i)));
  });

  it("8. a repeated, unchanged call returns an identical batch in identical order", async () => {
    const signals = Array.from({ length: 30 }, (_, i) => signalRow({ id: idOf(i), createdAtIso: ts(i) }));
    const workerRepo = makeFakeWorkerRepo(signals, []);
    const first = await workerRepo.findPendingSignals(20);
    const second = await workerRepo.findPendingSignals(20);
    expect(first).toEqual(second);
  });

  it("9. resolving the first pending signal advances the next call correctly", async () => {
    const signals = Array.from({ length: 5 }, (_, i) => signalRow({ id: idOf(i), createdAtIso: ts(i) }));
    const matches: ExistingMatchRow[] = [];
    const workerRepo = makeFakeWorkerRepo(signals, matches);
    const first = await workerRepo.findPendingSignals(20);
    expect(first[0]?.id).toBe(idOf(0));

    // Simulate resolving signal 0's both venues, then re-querying (a fresh call, not a cursor).
    matches.push({ signalId: idOf(0), venue: "PMUS" }, { signalId: idOf(0), venue: "KALSHI" });
    const second = await workerRepo.findPendingSignals(20);
    expect(second[0]?.id).toBe(idOf(1));
    expect(second.map((p) => p.id)).not.toContain(idOf(0));
  });

  it("ties on identical created_at break deterministically by id ascending", async () => {
    const sameTs = ts(0);
    const signals = [signalRow({ id: "sig-b", createdAtIso: sameTs }), signalRow({ id: "sig-a", createdAtIso: sameTs })];
    const workerRepo = makeFakeWorkerRepo(signals, []);
    const pending = await workerRepo.findPendingSignals(20);
    expect(pending.map((p) => p.id)).toEqual(["sig-a", "sig-b"]);
  });

  it("a limit clamp never allows an unbounded result even if a caller passes an absurd value", async () => {
    const signals = Array.from({ length: 150 }, (_, i) => signalRow({ id: idOf(i), createdAtIso: ts(i) }));
    const workerRepo = makeFakeWorkerRepo(signals, []);
    const pending = await workerRepo.findPendingSignals(10_000);
    expect(pending.length).toBeLessThanOrEqual(100); // clamped ceiling
  });

  it("the actual migration SQL matches the required semantics and security posture", () => {
    const sql = readFileSync(
      new URL("../../../supabase/migrations/20260820230000_sports_shadow_pending_signals_rpc.sql", import.meta.url),
      "utf8",
    );
    expect(sql).toContain("CREATE OR REPLACE FUNCTION public.find_pending_sports_shadow_signals");
    expect(sql).toMatch(/LANGUAGE sql/i);
    expect(sql).toMatch(/\bSTABLE\b/);
    expect(sql).toMatch(/SECURITY INVOKER/);
    expect(sql).toContain("SET search_path = public");
    expect(sql).toMatch(/LEFT JOIN public\.sports_market_matches/);
    expect(sql).toMatch(/WHERE\s+pmus_match\.id IS NULL OR kalshi_match\.id IS NULL/);
    expect(sql).toMatch(/ORDER BY s\.created_at ASC,\s*s\.id ASC/);
    expect(sql).toMatch(/LIMIT LEAST\(GREATEST\(COALESCE\(p_limit/);
    expect(sql).toContain("REVOKE ALL ON FUNCTION public.find_pending_sports_shadow_signals(integer) FROM PUBLIC, anon, authenticated");
    expect(sql).toContain("GRANT EXECUTE ON FUNCTION public.find_pending_sports_shadow_signals(integer) TO service_role");
    expect(sql).not.toMatch(/CREATE TABLE/); // no new table
  });
});

describe("runSportsShadowCycle — target discovery", () => {
  it("16. target discovery is performed exactly once per cycle, not once per pending signal", async () => {
    const signals = [signalRow({ id: "sig-1" }), signalRow({ id: "sig-2", createdAtIso: "2026-08-19T00:01:00.000Z" })];
    const workerRepo = makeFakeWorkerRepo(signals, []);
    const discoverPmus = vi.fn(async () => [] as PmusCandidate[]);
    const discoverKalshi = vi.fn(async () => [] as KalshiCandidate[]);
    await runSportsShadowCycle(enabledConfig(), baseDeps({ workerRepo, discoverPmus, discoverKalshi }));
    expect(discoverPmus).toHaveBeenCalledTimes(1);
    expect(discoverKalshi).toHaveBeenCalledTimes(1);
  });

  it("neither venue is discovered when there is no pending work", async () => {
    const discoverPmus = vi.fn(async () => [] as PmusCandidate[]);
    const discoverKalshi = vi.fn(async () => [] as KalshiCandidate[]);
    await runSportsShadowCycle(enabledConfig(), baseDeps({ discoverPmus, discoverKalshi }));
    expect(discoverPmus).not.toHaveBeenCalled();
    expect(discoverKalshi).not.toHaveBeenCalled();
  });
});

describe("runSportsShadowCycle — resolution and persistence semantics", () => {
  it("17. successful PMUS and Kalshi results are persisted independently for the same signal", async () => {
    const workerRepo = makeFakeWorkerRepo([signalRow()], []);
    const persistVenueMatch = vi.fn(async (_signalId: string, _result: VenueMatchResult, _detectedAtMs: number, _sourceTimestampIso: string) => ({ matchId: "m1", scheduled: 0, downgradeSkipped: false }));
    await runSportsShadowCycle(enabledConfig(), baseDeps({ workerRepo, persistVenueMatch: persistVenueMatch as never }));
    expect(persistVenueMatch).toHaveBeenCalledTimes(2); // once per venue
    const venues = persistVenueMatch.mock.calls.map((c) => (c[1] as VenueMatchResult).venue);
    expect(venues.sort()).toEqual(["KALSHI", "PMUS"]);
  });

  it("18. a PMUS discovery/network failure is NOT persisted as a semantic NONE -- PMUS resolution is skipped entirely, left retryable", async () => {
    const workerRepo = makeFakeWorkerRepo([signalRow()], []);
    const discoverPmus = vi.fn(async () => {
      throw new Error("gateway.polymarket.us timeout");
    });
    const persistVenueMatch = vi.fn(async (_signalId: string, _result: VenueMatchResult, _detectedAtMs: number, _sourceTimestampIso: string) => ({ matchId: "m1", scheduled: 0, downgradeSkipped: false }));
    const summary = await runSportsShadowCycle(enabledConfig(), baseDeps({ workerRepo, discoverPmus, persistVenueMatch: persistVenueMatch as never }));
    expect(summary.sourceLane?.pmus.discoveryFailed).toBe(true);
    expect(summary.sourceLane?.pmus.attempted).toBe(0);
    const pmusCalls = persistVenueMatch.mock.calls.filter((c) => (c[1] as VenueMatchResult).venue === "PMUS");
    expect(pmusCalls).toHaveLength(0); // never even attempted -- not persisted as NONE, not persisted at all
    // Kalshi proceeds independently despite the PMUS discovery failure.
    const kalshiCalls = persistVenueMatch.mock.calls.filter((c) => (c[1] as VenueMatchResult).venue === "KALSHI");
    expect(kalshiCalls).toHaveLength(1);
  });

  it("19. a Kalshi discovery/network failure is NOT persisted as a semantic NONE -- Kalshi resolution is skipped entirely, left retryable", async () => {
    const workerRepo = makeFakeWorkerRepo([signalRow()], []);
    const discoverKalshi = vi.fn(async () => {
      throw new Error("external-api.kalshi.com 503");
    });
    const persistVenueMatch = vi.fn(async (_signalId: string, _result: VenueMatchResult, _detectedAtMs: number, _sourceTimestampIso: string) => ({ matchId: "m1", scheduled: 0, downgradeSkipped: false }));
    const summary = await runSportsShadowCycle(enabledConfig(), baseDeps({ workerRepo, discoverKalshi, persistVenueMatch: persistVenueMatch as never }));
    expect(summary.sourceLane?.kalshi.discoveryFailed).toBe(true);
    const kalshiCalls = persistVenueMatch.mock.calls.filter((c) => (c[1] as VenueMatchResult).venue === "KALSHI");
    expect(kalshiCalls).toHaveLength(0);
    const pmusCalls = persistVenueMatch.mock.calls.filter((c) => (c[1] as VenueMatchResult).venue === "PMUS");
    expect(pmusCalls).toHaveLength(1);
  });

  it("20. a genuine semantic NONE from the resolver (successful discovery, no matching candidate) IS persisted", async () => {
    // Empty candidate arrays + a real resolver call (not mocked) => resolvePmusMatch/resolveKalshiMatch
    // legitimately return NONE_NO_CANDIDATE, which must reach persistVenueMatch.
    const workerRepo = makeFakeWorkerRepo([signalRow()], []);
    const persistVenueMatch = vi.fn(async (_signalId: string, _result: VenueMatchResult, _detectedAtMs: number, _sourceTimestampIso: string) => ({ matchId: "m1", scheduled: 0, downgradeSkipped: false }));
    await runSportsShadowCycle(enabledConfig(), baseDeps({ workerRepo, persistVenueMatch: persistVenueMatch as never }));
    const results = persistVenueMatch.mock.calls.map((c) => c[1] as VenueMatchResult);
    expect(results.every((r) => r.status === "NONE")).toBe(true);
  });

  it("21. an unparseable source outcome resolves UNVERIFIED (fail-closed), which is still persisted -- never silently dropped", async () => {
    const workerRepo = makeFakeWorkerRepo([signalRow({ selectedOutcomeRaw: "totally unparseable garbage" })], []);
    const persistVenueMatch = vi.fn(async (_signalId: string, _result: VenueMatchResult, _detectedAtMs: number, _sourceTimestampIso: string) => ({ matchId: "m1", scheduled: 0, downgradeSkipped: false }));
    await runSportsShadowCycle(enabledConfig(), baseDeps({ workerRepo, persistVenueMatch: persistVenueMatch as never }));
    const results = persistVenueMatch.mock.calls.map((c) => c[1] as VenueMatchResult);
    expect(results.every((r) => r.status === "UNVERIFIED")).toBe(true);
  });

  it("22. EXACT persistence goes exclusively through Task 8's persistVenueMatch -- no direct observation-row insert anywhere in the orchestrator", async () => {
    const source = readFileSync(new URL("./worker.server.ts", import.meta.url), "utf8");
    expect(source).not.toMatch(/sports_quote_observations/);
    expect(source).toContain("d.persistVenueMatch(");
  });

  it("27. detectedAtMs passed to persistVenueMatch comes from the signal's created_at, never from source_first_fill_at or the current clock", async () => {
    const workerRepo = makeFakeWorkerRepo([signalRow({ createdAtIso: "2026-08-19T00:00:00.000Z", sourceFirstFillAtIso: "2026-08-01T00:00:00.000Z" })], []);
    const persistVenueMatch = vi.fn(async (_signalId: string, _result: VenueMatchResult, _detectedAtMs: number, _sourceTimestampIso: string) => ({ matchId: "m1", scheduled: 0, downgradeSkipped: false }));
    await runSportsShadowCycle(enabledConfig(), baseDeps({ workerRepo, persistVenueMatch: persistVenueMatch as never, now: () => 9_999_999_999_999 }));
    for (const call of persistVenueMatch.mock.calls) {
      expect(call[2]).toBe(Date.parse("2026-08-19T00:00:00.000Z")); // detectedAtMs
      expect(call[3]).toBe("2026-08-01T00:00:00.000Z"); // sourceTimestampIso, preserved distinctly
    }
  });

  it("one bad signal does not crash the rest of the bounded pending batch", async () => {
    const signals = [signalRow({ id: "sig-bad", conditionId: null }), signalRow({ id: "sig-good", createdAtIso: "2026-08-19T00:01:00.000Z" })];
    const workerRepo = makeFakeWorkerRepo(signals, []);
    const persistVenueMatch = vi.fn(async (_signalId: string, _result: VenueMatchResult, _detectedAtMs: number, _sourceTimestampIso: string) => ({ matchId: "m1", scheduled: 0, downgradeSkipped: false }));
    const summary = await runSportsShadowCycle(enabledConfig(), baseDeps({ workerRepo, persistVenueMatch: persistVenueMatch as never }));
    expect(summary.sourceLane?.pendingProcessed).toBe(1); // only the good one
    expect(persistVenueMatch).toHaveBeenCalledTimes(2); // sig-good x 2 venues
  });
});

describe("runSportsShadowCycle — final +0 observation pass", () => {
  it("23. a final observation pass runs after the source lane and can capture a newly-due +0 row", async () => {
    let call = 0;
    const takeDueSportsShadowObservations = vi.fn(async () => {
      call += 1;
      return call === 1 ? { captured: 0, failed: 0, skipped: 0 } : { captured: 1, failed: 0, skipped: 0 };
    });
    const summary = await runSportsShadowCycle(enabledConfig(), baseDeps({ takeDueSportsShadowObservations: takeDueSportsShadowObservations as never }));
    expect(takeDueSportsShadowObservations).toHaveBeenCalledTimes(2);
    expect(summary.finalObservationPass.captured).toBe(1);
  });

  it("24. a held observation lease causes the final +0 pass to skip without waiting", async () => {
    const { repo: leaseRepo } = makeFakeLeaseRepo();
    const takeDueSportsShadowObservations = vi.fn(async () => emptyObservationCollectionResult());
    // Simulate: after lane A releases, something else grabs the observation lock before the final pass.
    const originalRelease = leaseRepo.release.bind(leaseRepo);
    let observationAcquireCount = 0;
    const wrappedRepo: SportsLeaseRepository = {
      acquire: async (lockId, workerId, leaseSeconds) => {
        if (lockId === OBSERVATION_LOCK_ID) {
          observationAcquireCount += 1;
          if (observationAcquireCount === 2) return null; // second (final-pass) attempt finds it held
        }
        return leaseRepo.acquire(lockId, workerId, leaseSeconds);
      },
      release: originalRelease,
    };
    const summary = await runSportsShadowCycle(enabledConfig(), baseDeps({ leaseRepo: wrappedRepo, takeDueSportsShadowObservations: takeDueSportsShadowObservations as never }));
    expect(summary.finalObservationPass.acquired).toBe(false);
    expect(takeDueSportsShadowObservations).toHaveBeenCalledTimes(1); // only lane A's pass ran
  });
});

describe("runSportsShadowCycle — telemetry", () => {
  it("28. the returned summary is JSON-safe (round-trips through JSON.stringify/parse) and bounded (no giant raw payloads)", async () => {
    const workerRepo = makeFakeWorkerRepo([signalRow()], []);
    const summary = await runSportsShadowCycle(enabledConfig(), baseDeps({ workerRepo }));
    const roundTripped = JSON.parse(JSON.stringify(summary));
    expect(roundTripped).toEqual(summary);
    expect(JSON.stringify(summary).length).toBeLessThan(20_000); // bounded, not a raw-payload dump
  });

  it("never exposes a secret/credential field in the summary", async () => {
    const summary = await runSportsShadowCycle(enabledConfig(), baseDeps());
    const json = JSON.stringify(summary).toLowerCase();
    expect(json).not.toMatch(/secret|api[_-]?key|private[_-]?key/);
  });
});

describe("runSportsShadowCycle — static safety audit", () => {
  it("29/30. the orchestrator source contains no live-order code, no daemon/timer, and never uses processFillsForTest", () => {
    const source = readFileSync(new URL("./worker.server.ts", import.meta.url), "utf8");
    expect(source).not.toMatch(/createOrder|submitOrder|cancelOrder|KALSHI_API_KEY|KALSHI_PRIVATE_KEY|LIVE_EXECUTION|PMUS_LIVE|KALSHI_LIVE|private[_-]?key/i);
    expect(source).not.toMatch(/setInterval|while\s*\(\s*true\s*\)/);
    expect(source).not.toMatch(/processFillsForTest/);
  });
});

describe("runSportsShadowCycle — observation-lane latency (TIMING_GATE remediation)", () => {
  it("the observation-stage budget stays strictly below the observation lease TTL, with a real margin", () => {
    // OBSERVATION_STAGE_DEADLINE_MS bounds how long a pass spends STARTING new rows; the
    // true worst-case lane hold also includes one row's own up-to-~12s in-flight ceiling,
    // which this module cannot preempt (see the module doc comment). The TTL must clear
    // that full worst case, not just the deadline budget alone.
    const ONE_ROW_WORST_CASE_MS = 12_000;
    const worstCaseLaneHoldMs = OBSERVATION_STAGE_DEADLINE_MS + ONE_ROW_WORST_CASE_MS;
    expect(worstCaseLaneHoldMs).toBeLessThan(OBSERVATION_LEASE_TTL_SECONDS * 1000);
  });

  it("passes a computed deadlineAtMs (now + OBSERVATION_STAGE_DEADLINE_MS) into takeDueSportsShadowObservations for the main pass -- a slow observation cannot silently drain the full maxRows batch unbounded", async () => {
    const FIXED_NOW_MS = 1_700_000_000_000;
    const takeDueSportsShadowObservations = vi.fn(async (_deps: unknown, _maxRows: number, _deadlineAtMs: number | null) => ({ captured: 0, failed: 0, skipped: 0 }));
    await runSportsShadowCycle(enabledConfig(), baseDeps({ takeDueSportsShadowObservations: takeDueSportsShadowObservations as never, now: () => FIXED_NOW_MS }));
    const mainPassCall = takeDueSportsShadowObservations.mock.calls[0]!;
    expect(mainPassCall[2]).toBe(FIXED_NOW_MS + OBSERVATION_STAGE_DEADLINE_MS);
  });

  it("passes a shorter deadline into the final +0 catch pass so it cannot itself become a second long hold", async () => {
    const FIXED_NOW_MS = 1_700_000_000_000;
    const takeDueSportsShadowObservations = vi.fn(async (_deps: unknown, _maxRows: number, _deadlineAtMs: number | null) => ({ captured: 0, failed: 0, skipped: 0 }));
    await runSportsShadowCycle(enabledConfig(), baseDeps({ takeDueSportsShadowObservations: takeDueSportsShadowObservations as never, now: () => FIXED_NOW_MS }));
    const finalPassCall = takeDueSportsShadowObservations.mock.calls[1]!;
    expect(finalPassCall[2]).toBe(FIXED_NOW_MS + FINAL_OBSERVATION_STAGE_DEADLINE_MS_FOR_TEST);
    expect(FINAL_OBSERVATION_STAGE_DEADLINE_MS_FOR_TEST).toBeLessThan(OBSERVATION_STAGE_DEADLINE_MS);
  });

  it("work left unstarted by a bounded observation pass stays durable (still due) for a later invocation, which can then acquire the lane once the lease is released", async () => {
    const { repo: leaseRepo } = makeFakeLeaseRepo();
    // First cycle: simulate a bounded pass that only got through some of the batch (this
    // module never sees per-row detail, only the aggregate result Task 8 returns).
    const takeDueSportsShadowObservationsFirst = vi.fn(async () => ({ captured: 2, failed: 0, skipped: 0 }));
    const first = await runSportsShadowCycle(enabledConfig(), baseDeps({ leaseRepo, takeDueSportsShadowObservations: takeDueSportsShadowObservationsFirst as never }));
    expect(first.observationLane.acquired).toBe(true);

    // A later invocation, sharing the SAME lease repo, can immediately acquire the
    // observation lane again -- the first cycle's clean release did not leave it locked.
    const takeDueSportsShadowObservationsSecond = vi.fn(async () => ({ captured: 3, failed: 0, skipped: 0 }));
    const second = await runSportsShadowCycle(enabledConfig(), baseDeps({ leaseRepo, takeDueSportsShadowObservations: takeDueSportsShadowObservationsSecond as never }));
    expect(second.observationLane.acquired).toBe(true);
    expect(second.observationLane.captured).toBe(3);
  });

  it("source lane remains fully independent of the observation-lane timing fix (still acquires/runs normally)", async () => {
    const pollSportsShadowWallet = vi.fn(async (wallet: string) => emptyWalletResult(wallet));
    const summary = await runSportsShadowCycle(enabledConfig(), baseDeps({ pollSportsShadowWallet: pollSportsShadowWallet as never }));
    expect(summary.sourceLane?.acquired).toBe(true);
    expect(pollSportsShadowWallet).toHaveBeenCalledTimes(1);
  });
});
