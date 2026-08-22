import { readFileSync } from "node:fs";

import { describe, expect, it, vi } from "vitest";

import type { SportsShadowConfig } from "./config";
import type { ExperimentEpoch } from "./epoch";
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
  OBSERVATION_LOCK_ID_KALSHI,
  OBSERVATION_LOCK_ID_PMUS,
  OBSERVATION_STAGE_DEADLINE_MS,
  SOURCE_LANE_BUDGET_MS,
  SOURCE_LOCK_ID,
  runSportsShadowCycle,
  type SportsShadowWorkerDeps,
  type WorkerRepository,
} from "./worker.server";

const WALLET_A = "0xa71093cafc0c099b4ccab24c3cb8018d817923c4";
const WALLET_B = "0x32ed517a571c01b6e9adecf61ba81ca48ff2f960";
const WALLET_C = "0x5268527977f700f9bf9b6d5cd843859e4e70135d";

function enabledConfig(overrides: Partial<SportsShadowConfig> = {}): SportsShadowConfig {
  return { enabled: true, wallets: [WALLET_A], goLiveAtMs: 1_700_000_000_000, gitSha: "test-sha", ...overrides };
}

function fakeEpoch(goLiveAtMs: number): ExperimentEpoch {
  return {
    id: "epoch-fake",
    createdAtIso: new Date(goLiveAtMs).toISOString(),
    goLiveAtIso: new Date(goLiveAtMs).toISOString(),
    walletCohort: [WALLET_A],
    gitSha: "test-sha",
    configHash: "test-hash",
    versions: {
      classifierVersion: "c1",
      episodeVersion: "e1",
      resolverVersion: "r1",
      routerVersion: "rt1",
      pmusFeeModelVersion: "pf1",
      kalshiFeeModelVersion: "kf1",
      executionSimulatorVersion: "x1",
      settlementVersion: "s1",
    },
    stage: "OPERATIONAL_SOAK",
    stageEnteredAtIso: new Date(goLiveAtMs).toISOString(),
    soakStartedAtIso: new Date(goLiveAtMs).toISOString(),
    calibrationStartedAtIso: null,
    oosStartedAtIso: null,
    frozenAtIso: null,
  };
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
    async renew(lease, leaseSeconds) {
      const existing = rows.get(lease.lockId);
      if (!existing || existing.fence !== lease.fence || existing.workerId !== lease.workerId) return false;
      if (existing.expiresAtMs <= Date.now()) return false;
      rows.set(lease.lockId, { ...existing, expiresAtMs: Date.now() + leaseSeconds * 1000 });
      return true;
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
 * supabase/migrations/20260820230000_sports_shadow_pending_signals_rpc.sql, revised for
 * Task 12D/P1-C): a LEFT JOIN anti-join, now scoped to exactly ONE requested venue (never
 * combined via OR), ORDER BY (created_at ASC, id ASC), LIMIT clamped to [0, 100] with a
 * NULL-safe default of 20. Standing in for the real-Postgres validation this environment
 * could not perform locally (no cached postgres:17 image) — the real proof lives in
 * supabase/tests/sports_shadow_pending_signals_rpc.sql, run against a real database in CI.
 */
function makeFakeWorkerRepo(signals: SignalRow[], matches: ExistingMatchRow[], initialCursor = 0) {
  let cursor = initialCursor;
  const cursorReadLog: number[] = [];
  const cursorWriteLog: number[] = [];
  const repo: WorkerRepository & { getCursorForTest: () => number; cursorReadLog: number[]; cursorWriteLog: number[] } = {
    async findPendingSignalsForVenue(venue, limit) {
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
        .filter((s) => (venue === "PMUS" ? s.missingPmus : s.missingKalshi));
      return pending.slice(0, clampedLimit);
    },
    async getWalletCursor() {
      cursorReadLog.push(cursor);
      return cursor;
    },
    async setWalletCursor(next) {
      cursor = next;
      cursorWriteLog.push(next);
    },
    getCursorForTest: () => cursor,
    cursorReadLog,
    cursorWriteLog,
  };
  return repo;
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
    terminalUnverifiedRows: 0,
    suppressedPreGoLive: 0,
    newSignals: [],
    aggregatedCount: 0,
    sellRecordedCount: 0,
    lateReconciliationCount: 0,
    backlogTruncated: false,
    orphanedFillsRecovered: 0,
    leaseLost: false,
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
    ensureCurrentEpoch: vi.fn(async (_wallets: readonly string[], goLiveAtMs: number) => fakeEpoch(goLiveAtMs)) as unknown as SportsShadowWorkerDeps["ensureCurrentEpoch"],
    now: () => 1_700_000_100_000,
    ...overrides,
  };
}

describe("runSportsShadowCycle — disabled config", () => {
  it("4. performs no source work and no observation work when disabled", async () => {
    const pollSportsShadowWallet = vi.fn();
    const takeDueSportsShadowObservations = vi.fn();
    const summary = await runSportsShadowCycle(
      { enabled: false, wallets: [], goLiveAtMs: null, gitSha: "test-sha" },
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

  it("8. source lease already held by another invocation does NOT prevent the observation lanes from running", async () => {
    const { repo: leaseRepo } = makeFakeLeaseRepo();
    // Pre-hold the SOURCE lock only.
    await leaseRepo.acquire(SOURCE_LOCK_ID, "other-invocation", 60);
    const takeDueSportsShadowObservations = vi.fn(async () => emptyObservationCollectionResult());
    const summary = await runSportsShadowCycle(enabledConfig(), baseDeps({ leaseRepo, takeDueSportsShadowObservations: takeDueSportsShadowObservations as never }));
    expect(summary.observationLane.pmus.acquired).toBe(true);
    expect(summary.observationLane.kalshi.acquired).toBe(true);
    expect(summary.sourceLane?.acquired).toBe(false);
    expect(takeDueSportsShadowObservations).toHaveBeenCalled();
  });

  it("9. observation lease already held does not corrupt or block independent source lease acquisition", async () => {
    const { repo: leaseRepo } = makeFakeLeaseRepo();
    await leaseRepo.acquire(OBSERVATION_LOCK_ID_PMUS, "other-invocation", 90);
    await leaseRepo.acquire(OBSERVATION_LOCK_ID_KALSHI, "other-invocation", 90);
    const pollSportsShadowWallet = vi.fn(async (wallet: string) => emptyWalletResult(wallet));
    const summary = await runSportsShadowCycle(enabledConfig(), baseDeps({ leaseRepo, pollSportsShadowWallet: pollSportsShadowWallet as never }));
    expect(summary.observationLane.pmus.acquired).toBe(false);
    expect(summary.observationLane.kalshi.acquired).toBe(false);
    expect(summary.sourceLane?.acquired).toBe(true);
    expect(pollSportsShadowWallet).toHaveBeenCalled();
  });

  it("Task 12H / P1-N, N7: PM-US's observation lease being held does NOT block Kalshi's independent lease from being acquired", async () => {
    const { repo: leaseRepo } = makeFakeLeaseRepo();
    await leaseRepo.acquire(OBSERVATION_LOCK_ID_PMUS, "other-invocation", 90);
    const takeDueSportsShadowObservations = vi.fn(async () => emptyObservationCollectionResult());
    const summary = await runSportsShadowCycle(enabledConfig(), baseDeps({ leaseRepo, takeDueSportsShadowObservations: takeDueSportsShadowObservations as never }));
    expect(summary.observationLane.pmus.acquired).toBe(false);
    expect(summary.observationLane.kalshi.acquired).toBe(true);
  });

  it("Task 12H / P1-N, N2: a slow PM-US observation fetch does NOT delay Kalshi's lane from STARTING -- both lanes begin concurrently, proven by real call-order timing, not just eventual independent completion", async () => {
    const order: string[] = [];
    let resolvePmus!: () => void;
    const pmusStarted = new Promise<void>((resolve) => {
      resolvePmus = resolve;
    });
    const takeDueSportsShadowObservations = vi.fn(async (venue: Venue) => {
      order.push(`${venue}-start`);
      if (venue === "PMUS") {
        // Simulate a slow PM-US fetch (e.g. close to its 12s fetch timeout) that has not
        // resolved yet by the time we assert Kalshi already started.
        await new Promise((resolve) => setTimeout(resolve, 5));
      } else {
        resolvePmus(); // signal that Kalshi has started while PMUS is still pending
      }
      order.push(`${venue}-end`);
      return emptyObservationCollectionResult();
    });
    const cyclePromise = runSportsShadowCycle(enabledConfig(), baseDeps({ takeDueSportsShadowObservations: takeDueSportsShadowObservations as never }));
    await pmusStarted; // Kalshi's own call started BEFORE PMUS's slow call finished
    expect(order).toContain("KALSHI-start");
    expect(order).not.toContain("PMUS-end"); // PMUS's slow work is still in flight at this point
    await cyclePromise;
    expect(order.filter((e) => e.endsWith("-start")).length).toBeGreaterThanOrEqual(2);
  });

  it("Task 12H / P1-N, N2b/N9: each venue's observation lane receives its OWN full maxRows/deadline budget -- a PMUS backlog cannot shrink Kalshi's allotment (no shared/pooled counter)", async () => {
    const seenArgs: Array<{ venue: Venue; maxRows: number; deadlineAtMs: number }> = [];
    const takeDueSportsShadowObservations = vi.fn(async (venue: Venue, _deps: unknown, maxRows: number, deadlineAtMs: number) => {
      seenArgs.push({ venue, maxRows, deadlineAtMs });
      return emptyObservationCollectionResult();
    });
    await runSportsShadowCycle(enabledConfig(), baseDeps({ takeDueSportsShadowObservations: takeDueSportsShadowObservations as never }));
    const mainPassCalls = seenArgs.slice(0, 2);
    const pmusCall = mainPassCalls.find((c) => c.venue === "PMUS")!;
    const kalshiCall = mainPassCalls.find((c) => c.venue === "KALSHI")!;
    expect(pmusCall.maxRows).toBe(kalshiCall.maxRows); // identical, independent budgets -- neither is reduced by the other
    expect(pmusCall.deadlineAtMs).toBeGreaterThan(0);
    expect(kalshiCall.deadlineAtMs).toBeGreaterThan(0);
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

describe("runSportsShadowCycle — wallet polling (fixed order)", () => {
  it("12. source poll is called exactly once per configured wallet, deterministically (rotation cursor starts at 0)", async () => {
    const calls: string[] = [];
    const pollSportsShadowWallet = vi.fn(async (wallet: string) => {
      calls.push(wallet);
      return emptyWalletResult(wallet);
    });
    await runSportsShadowCycle(enabledConfig({ wallets: [WALLET_A, WALLET_B] }), baseDeps({ pollSportsShadowWallet: pollSportsShadowWallet as never }));
    expect(calls).toEqual([WALLET_A, WALLET_B]);
  });

  it("Task 13F: every wallet call receives an explicit deadlineAtMs (4th argument) -- not merely 'no deadline at all' as before", async () => {
    const pollSportsShadowWallet = vi.fn(async (wallet: string, _goLiveAtMs: number | null, _deps: unknown, _deadlineAtMs: number) => emptyWalletResult(wallet));
    await runSportsShadowCycle(enabledConfig({ wallets: [WALLET_A, WALLET_B, WALLET_C] }), baseDeps({ pollSportsShadowWallet: pollSportsShadowWallet as never }));
    for (const call of pollSportsShadowWallet.mock.calls) {
      expect(typeof call[3]).toBe("number");
      expect(Number.isFinite(call[3])).toBe(true);
    }
  });

  it("Task 13F: all wallets in ONE lane share the SAME lane-wide deadline (laneStartMs + SOURCE_LANE_BUDGET_MS) -- not a fresh per-wallet budget that would let N wallets each independently consume up to 30s", async () => {
    const pollSportsShadowWallet = vi.fn(async (wallet: string, _goLiveAtMs: number | null, _deps: unknown, _deadlineAtMs: number) => emptyWalletResult(wallet));
    await runSportsShadowCycle(enabledConfig({ wallets: [WALLET_A, WALLET_B, WALLET_C] }), baseDeps({ pollSportsShadowWallet: pollSportsShadowWallet as never }));
    const deadlines = pollSportsShadowWallet.mock.calls.map((call) => call[3]);
    expect(new Set(deadlines).size).toBe(1); // identical deadline value passed to every wallet this lane
  });

  it("SOAK-INCIDENT FIX: the wallet-poll deadline is the RESERVED ingest sub-budget (lane start + 30s - VENUE_MATCH_RESERVE_MS), so heavy ingestion can never consume the venue-matching lanes' budget", async () => {
    const fixedNow = 1_700_000_000_000;
    const pollSportsShadowWallet = vi.fn(async (wallet: string, _goLiveAtMs: number | null, _deps: unknown, _deadlineAtMs: number) => emptyWalletResult(wallet));
    await runSportsShadowCycle(enabledConfig({ wallets: [WALLET_A] }), baseDeps({ pollSportsShadowWallet: pollSportsShadowWallet as never, now: () => fixedNow }));
    expect(pollSportsShadowWallet.mock.calls[0]?.[3]).toBe(sourceIngestDeadline(fixedNow));
    expect(pollSportsShadowWallet.mock.calls[0]?.[3]).toBeLessThan(fixedNow + SOURCE_LANE_BUDGET_MS);
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

  it("Task 10's orphanedFillsRecovered is surfaced in the wallet summary, not hidden", async () => {
    const pollSportsShadowWallet = vi.fn(async (wallet: string) => emptyWalletResult(wallet, { orphanedFillsRecovered: 3 }));
    const summary = await runSportsShadowCycle(enabledConfig(), baseDeps({ pollSportsShadowWallet: pollSportsShadowWallet as never }));
    expect(summary.sourceLane?.walletSummaries[0]?.orphanedFillsRecovered).toBe(3);
  });
});

describe("runSportsShadowCycle — epoch attribution (repository-completion pass)", () => {
  it("resolves the current epoch once per cycle and threads its id into every wallet's poll deps so new episodes are attributed to it", async () => {
    const ensureCurrentEpoch = vi.fn(async (_wallets: readonly string[], goLiveAtMs: number) => fakeEpoch(goLiveAtMs));
    const pollSportsShadowWallet = vi.fn(async (wallet: string, _goLiveAtMs: number | null, deps: { epochId: string | null }) => emptyWalletResult(wallet));
    await runSportsShadowCycle(
      enabledConfig({ wallets: [WALLET_A, WALLET_B] }),
      baseDeps({ ensureCurrentEpoch: ensureCurrentEpoch as never, pollSportsShadowWallet: pollSportsShadowWallet as never }),
    );
    expect(ensureCurrentEpoch).toHaveBeenCalledTimes(1);
    for (const call of pollSportsShadowWallet.mock.calls) {
      expect(call[2].epochId).toBe("epoch-fake");
    }
  });

  it("a failed ensureCurrentEpoch is recorded as a cycle error but never blocks wallet polling -- episodes still get created (epochId null) rather than data collection stalling on epoch bookkeeping", async () => {
    const ensureCurrentEpoch = vi.fn(async () => {
      throw new Error("epoch table unreachable");
    });
    const pollSportsShadowWallet = vi.fn(async (wallet: string, _goLiveAtMs: number | null, deps: { epochId: string | null }) => emptyWalletResult(wallet));
    const summary = await runSportsShadowCycle(
      enabledConfig({ wallets: [WALLET_A] }),
      baseDeps({ ensureCurrentEpoch: ensureCurrentEpoch as never, pollSportsShadowWallet: pollSportsShadowWallet as never }),
    );
    expect(summary.errors.some((e) => e.includes("ensureCurrentEpoch failed"))).toBe(true);
    expect(pollSportsShadowWallet).toHaveBeenCalledTimes(1);
    expect(pollSportsShadowWallet.mock.calls[0]?.[2].epochId).toBeNull();
  });

  it("Codex-caught P1 regression: summary.epochId is populated even when the source lease is NOT acquired this cycle -- epoch resolution must not live inside runSourceLane, or every telemetry event this cycle would be written with experiment_epoch_id NULL", async () => {
    const { repo: leaseRepo } = makeFakeLeaseRepo();
    await leaseRepo.acquire(SOURCE_LOCK_ID, "other-invocation", 60); // source lease held elsewhere -- runSourceLane never runs this cycle
    const ensureCurrentEpoch = vi.fn(async (_wallets: readonly string[], goLiveAtMs: number) => fakeEpoch(goLiveAtMs));
    const summary = await runSportsShadowCycle(enabledConfig(), baseDeps({ leaseRepo, ensureCurrentEpoch: ensureCurrentEpoch as never }));
    expect(summary.sourceLane?.acquired).toBe(false);
    expect(ensureCurrentEpoch).toHaveBeenCalledTimes(1);
    expect(summary.epochId).toBe("epoch-fake");
  });
});

describe("runSportsShadowCycle — Task 12D/P1-B wallet fairness", () => {
  it("reads the durable wallet cursor at the start of the lane and starts iteration from it", async () => {
    const workerRepo = makeFakeWorkerRepo([], [], 1); // cursor starts pointing at WALLET_B
    const calls: string[] = [];
    const pollSportsShadowWallet = vi.fn(async (wallet: string) => {
      calls.push(wallet);
      return emptyWalletResult(wallet);
    });
    await runSportsShadowCycle(enabledConfig({ wallets: [WALLET_A, WALLET_B, WALLET_C] }), baseDeps({ workerRepo, pollSportsShadowWallet: pollSportsShadowWallet as never }));
    expect(calls).toEqual([WALLET_B, WALLET_C, WALLET_A]); // rotated to start at index 1
  });

  it("advances the durable cursor by the number of wallets actually attempted, even when the budget truncates the cycle partway through", async () => {
    const workerRepo = makeFakeWorkerRepo([], [], 0);
    let now = 1_700_000_100_000;
    const pollSportsShadowWallet = vi.fn(async (wallet: string) => {
      if (wallet === WALLET_A) now += 31_000; // consumes the whole 30s SOURCE_LANE_BUDGET_MS
      return emptyWalletResult(wallet);
    });
    await runSportsShadowCycle(
      enabledConfig({ wallets: [WALLET_A, WALLET_B, WALLET_C] }),
      baseDeps({ workerRepo, pollSportsShadowWallet: pollSportsShadowWallet as never, now: () => now }),
    );
    // Only WALLET_A was attempted before the budget broke the loop -- cursor must advance
    // by exactly 1, so WALLET_B is FIRST next cycle, not WALLET_A again.
    expect(workerRepo.getCursorForTest()).toBe(1);
  });

  it("a persistently slow wallet A cannot permanently starve B/C -- successive cycles still give them opportunities", async () => {
    const workerRepo = makeFakeWorkerRepo([], [], 0);
    let now = 1_700_000_100_000;
    const attemptedByCycle: string[][] = [];
    for (let cycle = 0; cycle < 3; cycle += 1) {
      const thisCycleAttempts: string[] = [];
      const pollSportsShadowWallet = vi.fn(async (wallet: string) => {
        thisCycleAttempts.push(wallet);
        now += 31_000; // EVERY wallet consumes the full budget -- worst-case slow-wallet scenario
        return emptyWalletResult(wallet);
      });
      await runSportsShadowCycle(
        enabledConfig({ wallets: [WALLET_A, WALLET_B, WALLET_C] }),
        baseDeps({ workerRepo, pollSportsShadowWallet: pollSportsShadowWallet as never, now: () => now }),
      );
      attemptedByCycle.push(thisCycleAttempts);
    }
    // Each cycle attempts exactly one wallet (budget consumed immediately), but across 3
    // cycles, all three DIFFERENT wallets got a turn -- none was skipped forever.
    expect(attemptedByCycle.every((c) => c.length === 1)).toBe(true);
    expect(new Set(attemptedByCycle.map((c) => c[0]))).toEqual(new Set([WALLET_A, WALLET_B, WALLET_C]));
  });

  it("a restart (fresh deps, no in-memory state) does not reset into permanent A-first starvation -- the cursor is read fresh from the durable repo every time", async () => {
    const workerRepo = makeFakeWorkerRepo([], [], 2); // durable state says "start at C"
    const calls: string[] = [];
    const pollSportsShadowWallet = vi.fn(async (wallet: string) => {
      calls.push(wallet);
      return emptyWalletResult(wallet);
    });
    // A brand new deps object standing in for a fresh process -- nothing carried over
    // except the durable repo itself. baseDeps() spread FIRST so its own default
    // workerRepo/pollSportsShadowWallet do not clobber the ones under test.
    await runSportsShadowCycle(enabledConfig({ wallets: [WALLET_A, WALLET_B, WALLET_C] }), { ...baseDeps(), workerRepo, pollSportsShadowWallet: pollSportsShadowWallet as never });
    expect(calls[0]).toBe(WALLET_C);
  });

  it("cohort resize (wallet removed) does not crash and stays within bounds", async () => {
    const workerRepo = makeFakeWorkerRepo([], [], 2); // cursor pointed at index 2 of a 3-wallet cohort
    const calls: string[] = [];
    const pollSportsShadowWallet = vi.fn(async (wallet: string) => {
      calls.push(wallet);
      return emptyWalletResult(wallet);
    });
    // Cohort shrunk to 2 wallets -- index 2 no longer exists, must wrap safely.
    await runSportsShadowCycle(enabledConfig({ wallets: [WALLET_A, WALLET_B] }), baseDeps({ workerRepo, pollSportsShadowWallet: pollSportsShadowWallet as never }));
    expect(calls).toHaveLength(2);
    expect(new Set(calls)).toEqual(new Set([WALLET_A, WALLET_B]));
  });

  it("a wallet cursor read failure falls back to 0 (start of cohort) rather than crashing the cycle", async () => {
    const workerRepo: WorkerRepository = {
      async findPendingSignalsForVenue() {
        return [];
      },
      async getWalletCursor() {
        throw new Error("db unreachable");
      },
      async setWalletCursor() {},
    };
    const calls: string[] = [];
    const pollSportsShadowWallet = vi.fn(async (wallet: string) => {
      calls.push(wallet);
      return emptyWalletResult(wallet);
    });
    const summary = await runSportsShadowCycle(enabledConfig({ wallets: [WALLET_A, WALLET_B] }), baseDeps({ workerRepo, pollSportsShadowWallet: pollSportsShadowWallet as never }));
    expect(calls).toEqual([WALLET_A, WALLET_B]);
    expect(summary.errors.some((e) => e.includes("wallet cursor read failed"))).toBe(true);
  });

  it("a wallet cursor write failure is non-fatal -- the cycle's results are still returned", async () => {
    const workerRepo: WorkerRepository = {
      async findPendingSignalsForVenue() {
        return [];
      },
      async getWalletCursor() {
        return 0;
      },
      async setWalletCursor() {
        throw new Error("db unreachable");
      },
    };
    const summary = await runSportsShadowCycle(enabledConfig(), baseDeps({ workerRepo }));
    expect(summary.sourceLane?.walletsAttempted).toBe(1);
    expect(summary.errors.some((e) => e.includes("wallet cursor write failed"))).toBe(true);
  });

  it("duplicate source polling under rotation remains protected by Task 10 idempotency (rotation only changes ORDER, never causes a wallet to be polled twice in one cycle)", async () => {
    const workerRepo = makeFakeWorkerRepo([], [], 1);
    const calls: string[] = [];
    const pollSportsShadowWallet = vi.fn(async (wallet: string) => {
      calls.push(wallet);
      return emptyWalletResult(wallet);
    });
    await runSportsShadowCycle(enabledConfig({ wallets: [WALLET_A, WALLET_B, WALLET_C] }), baseDeps({ workerRepo, pollSportsShadowWallet: pollSportsShadowWallet as never }));
    expect(calls).toHaveLength(3);
    expect(new Set(calls).size).toBe(3); // every wallet exactly once
  });

  it("boundedness remains intact: the source lane budget still stops scheduling further wallets regardless of rotation start point", async () => {
    const workerRepo = makeFakeWorkerRepo([], [], 1);
    let now = 1_700_000_100_000;
    const calls: string[] = [];
    const pollSportsShadowWallet = vi.fn(async (wallet: string) => {
      calls.push(wallet);
      now += 31_000;
      return emptyWalletResult(wallet);
    });
    await runSportsShadowCycle(
      enabledConfig({ wallets: [WALLET_A, WALLET_B, WALLET_C] }),
      baseDeps({ workerRepo, pollSportsShadowWallet: pollSportsShadowWallet as never, now: () => now }),
    );
    expect(calls).toHaveLength(1); // budget stopped after the first (rotated) wallet
  });
});

describe("runSportsShadowCycle — durable pending-signal recovery (crash-recovery hard gate)", () => {
  it("13. a signal persisted by a PRIOR invocation and orphaned before resolution is recovered even when this cycle's newlyCreatedSignals is empty", async () => {
    // pollSportsShadowWallet returns ZERO newSignals this cycle (simulating: the source
    // fill is now a duplicate because it was already durably persisted before a crash).
    const pollSportsShadowWallet = vi.fn(async (wallet: string) => emptyWalletResult(wallet, { newSignals: [] }));
    const workerRepo = makeFakeWorkerRepo([signalRow({ id: "orphaned-signal" })], []); // exists durably, zero match rows -- pending for BOTH venues
    const persistVenueMatch = vi.fn(async (_signalId: string, _result: VenueMatchResult, _detectedAtMs: number, _sourceTimestampIso: string) => ({ matchId: "m1", scheduled: 0, downgradeSkipped: false }));

    const summary = await runSportsShadowCycle(
      enabledConfig(),
      baseDeps({ pollSportsShadowWallet: pollSportsShadowWallet as never, workerRepo, persistVenueMatch: persistVenueMatch as never }),
    );

    expect(summary.sourceLane?.newSignalsCreated).toBe(0);
    expect(summary.sourceLane?.pmus.pendingFound).toBe(1);
    expect(summary.sourceLane?.kalshi.pendingFound).toBe(1);
    expect(summary.sourceLane?.pmus.pendingProcessed).toBe(1);
    expect(summary.sourceLane?.kalshi.pendingProcessed).toBe(1);
    expect(persistVenueMatch).toHaveBeenCalledWith("orphaned-signal", expect.anything(), expect.anything(), expect.anything(), expect.anything(), expect.anything());
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
    expect(summary.sourceLane?.pmus.pendingFound).toBe(0);
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

  it("25. a bounded pending-signal batch (per venue) leaves excess work durable for a future cycle", async () => {
    const many = Array.from({ length: 25 }, (_, i) => signalRow({ id: `sig-${i}`, createdAtIso: `2026-08-19T00:${String(i).padStart(2, "0")}:00.000Z` }));
    const workerRepo = makeFakeWorkerRepo(many, []);
    const summary = await runSportsShadowCycle(enabledConfig(), baseDeps({ workerRepo }));
    expect(summary.sourceLane?.pmus.pendingFound).toBeLessThan(25); // capped at PENDING_BATCH_SIZE (20)
    expect(summary.sourceLane?.pmus.pendingRemainingHint).toBe(true);
    expect(summary.sourceLane?.kalshi.pendingFound).toBeLessThan(25);
    expect(summary.sourceLane?.kalshi.pendingRemainingHint).toBe(true);
  });
});

describe("find_pending_sports_shadow_signals RPC semantics, per venue (Task 11B + Task 12D/P1-C)", () => {
  function idOf(i: number): string {
    return `sig-${String(i).padStart(4, "0")}`;
  }
  function ts(minuteOffset: number): string {
    const base = Date.parse("2026-08-01T00:00:00.000Z");
    return new Date(base + minuteOffset * 60_000).toISOString();
  }

  it("1. 220 signals, 1-200 fully resolved for PMUS, 201 unresolved for PMUS => signal 201 is returned first (the confirmed starvation scenario, now proven per-venue)", async () => {
    const signals = Array.from({ length: 220 }, (_, i) => signalRow({ id: idOf(i), createdAtIso: ts(i) }));
    const matches: ExistingMatchRow[] = [];
    for (let i = 0; i < 200; i += 1) matches.push({ signalId: idOf(i), venue: "PMUS" });
    const workerRepo = makeFakeWorkerRepo(signals, matches);
    const pending = await workerRepo.findPendingSignalsForVenue("PMUS", 20);
    expect(pending.map((p) => p.id)).toContain(idOf(200));
    expect(pending[0]?.id).toBe(idOf(200));
  });

  it("2. unresolved rows scattered above and below index 200 => the globally oldest unresolved one wins, regardless of position", async () => {
    const signals = Array.from({ length: 300 }, (_, i) => signalRow({ id: idOf(i), createdAtIso: ts(i) }));
    const matches: ExistingMatchRow[] = [];
    for (let i = 0; i < 300; i += 1) {
      if (i === 50 || i === 250) continue;
      matches.push({ signalId: idOf(i), venue: "PMUS" });
    }
    const workerRepo = makeFakeWorkerRepo(signals, matches);
    const pending = await workerRepo.findPendingSignalsForVenue("PMUS", 20);
    expect(pending.map((p) => p.id)).toEqual([idOf(50), idOf(250)]);
  });

  it("3/4/5. missingPmus/missingKalshi flags are still both reported even in a venue-scoped result", async () => {
    const pmusOnly = makeFakeWorkerRepo([signalRow()], [{ signalId: "sig-1", venue: "KALSHI" }]);
    expect(await pmusOnly.findPendingSignalsForVenue("PMUS", 20)).toEqual([expect.objectContaining({ id: "sig-1", missingPmus: true, missingKalshi: false })]);

    const kalshiOnly = makeFakeWorkerRepo([signalRow()], [{ signalId: "sig-1", venue: "PMUS" }]);
    expect(await kalshiOnly.findPendingSignalsForVenue("KALSHI", 20)).toEqual([expect.objectContaining({ id: "sig-1", missingPmus: false, missingKalshi: true })]);

    const both = makeFakeWorkerRepo([signalRow()], []);
    expect(await both.findPendingSignalsForVenue("PMUS", 20)).toEqual([expect.objectContaining({ missingPmus: true, missingKalshi: true })]);
    expect(await both.findPendingSignalsForVenue("KALSHI", 20)).toEqual([expect.objectContaining({ missingPmus: true, missingKalshi: true })]);
  });

  it("6. a fully resolved signal is excluded from BOTH venue queries", async () => {
    const workerRepo = makeFakeWorkerRepo([signalRow()], [{ signalId: "sig-1", venue: "PMUS" }, { signalId: "sig-1", venue: "KALSHI" }]);
    expect(await workerRepo.findPendingSignalsForVenue("PMUS", 20)).toHaveLength(0);
    expect(await workerRepo.findPendingSignalsForVenue("KALSHI", 20)).toHaveLength(0);
  });

  it("7. more pending than the batch size => exactly the bounded, deterministic, oldest batch", async () => {
    const signals = Array.from({ length: 50 }, (_, i) => signalRow({ id: idOf(i), createdAtIso: ts(i) }));
    const workerRepo = makeFakeWorkerRepo(signals, []);
    const pending = await workerRepo.findPendingSignalsForVenue("PMUS", 20);
    expect(pending).toHaveLength(20);
    expect(pending.map((p) => p.id)).toEqual(Array.from({ length: 20 }, (_, i) => idOf(i)));
  });

  it("8. p_limit > 100 is clamped to 100", async () => {
    const signals = Array.from({ length: 150 }, (_, i) => signalRow({ id: idOf(i), createdAtIso: ts(i) }));
    const workerRepo = makeFakeWorkerRepo(signals, []);
    expect((await workerRepo.findPendingSignalsForVenue("PMUS", 500)).length).toBeLessThanOrEqual(100);
  });

  it("9. resolving the first pending signal's PMUS venue advances the next PMUS call correctly, without touching the KALSHI queue", async () => {
    const signals = Array.from({ length: 5 }, (_, i) => signalRow({ id: idOf(i), createdAtIso: ts(i) }));
    const matches: ExistingMatchRow[] = [];
    const workerRepo = makeFakeWorkerRepo(signals, matches);
    const firstPmus = await workerRepo.findPendingSignalsForVenue("PMUS", 20);
    expect(firstPmus[0]?.id).toBe(idOf(0));

    matches.push({ signalId: idOf(0), venue: "PMUS" });
    const secondPmus = await workerRepo.findPendingSignalsForVenue("PMUS", 20);
    expect(secondPmus[0]?.id).toBe(idOf(1));
    expect(secondPmus.map((p) => p.id)).not.toContain(idOf(0));

    // idOf(0) is still missing KALSHI -- resolving PMUS alone must not have advanced it out of the KALSHI queue.
    const kalshi = await workerRepo.findPendingSignalsForVenue("KALSHI", 20);
    expect(kalshi.map((p) => p.id)).toContain(idOf(0));
  });

  it("ties on identical created_at break deterministically by id ascending", async () => {
    const sameTs = ts(0);
    const signals = [signalRow({ id: "sig-b", createdAtIso: sameTs }), signalRow({ id: "sig-a", createdAtIso: sameTs })];
    const workerRepo = makeFakeWorkerRepo(signals, []);
    const pending = await workerRepo.findPendingSignalsForVenue("PMUS", 20);
    expect(pending.map((p) => p.id)).toEqual(["sig-a", "sig-b"]);
  });

  it("the actual migration SQL matches the required venue-scoped semantics and security posture", () => {
    const sql = readFileSync(
      new URL("../../../supabase/migrations/20260820230000_sports_shadow_pending_signals_rpc.sql", import.meta.url),
      "utf8",
    );
    expect(sql).toContain("CREATE OR REPLACE FUNCTION public.find_pending_sports_shadow_signals");
    expect(sql).toContain("p_venue text");
    expect(sql).toMatch(/LANGUAGE sql/i);
    expect(sql).toMatch(/\bSTABLE\b/);
    expect(sql).toMatch(/SECURITY INVOKER/);
    expect(sql).toContain("SET search_path = public");
    expect(sql).toMatch(/LEFT JOIN public\.sports_market_matches/);
    expect(sql).toMatch(/\(p_venue = 'PMUS' AND pmus_match\.id IS NULL\)/);
    expect(sql).toMatch(/\(p_venue = 'KALSHI' AND kalshi_match\.id IS NULL\)/);
    // The actual WHERE clause (not doc-comment prose describing the old behavior) must be
    // the new venue-scoped form, never the old combined-OR clause.
    const whereClause = sql.slice(sql.indexOf("$$\n  SELECT"));
    expect(whereClause).not.toMatch(/WHERE\s+pmus_match\.id IS NULL OR kalshi_match\.id IS NULL/);
    expect(sql).toMatch(/ORDER BY s\.created_at ASC,\s*s\.id ASC/);
    expect(sql).toMatch(/LIMIT LEAST\(GREATEST\(COALESCE\(p_limit/);
    expect(sql).toContain("REVOKE ALL ON FUNCTION public.find_pending_sports_shadow_signals(text, integer) FROM PUBLIC, anon, authenticated");
    expect(sql).toContain("GRANT EXECUTE ON FUNCTION public.find_pending_sports_shadow_signals(text, integer) TO service_role");
    expect(sql).not.toMatch(/CREATE TABLE/); // no new table
  });
});

describe("runSportsShadowCycle — Task 12D/P1-C per-venue head-of-line-blocking proof", () => {
  it("a saturated PMUS-missing backlog (20+ old rows) does not prevent a newer Kalshi-only-missing signal from being resolved", async () => {
    // 25 old signals genuinely stuck on PMUS specifically -- already resolved for Kalshi
    // (a real match row exists), so they occupy the PMUS queue but never the Kalshi one.
    // Enough to saturate the PMUS batch (limit 20) every cycle.
    const oldSignals = Array.from({ length: 25 }, (_, i) => signalRow({ id: `old-${i}`, createdAtIso: `2026-08-01T00:${String(i).padStart(2, "0")}:00.000Z` }));
    // One NEWER signal missing ONLY Kalshi (PMUS already resolved for it).
    const newerSignal = signalRow({ id: "newer-kalshi-only", createdAtIso: "2026-08-02T00:00:00.000Z" });
    const matches: ExistingMatchRow[] = [
      ...oldSignals.map((s) => ({ signalId: s.id, venue: "KALSHI" as const })),
      { signalId: "newer-kalshi-only", venue: "PMUS" },
    ];
    const workerRepo = makeFakeWorkerRepo([...oldSignals, newerSignal], matches);

    const persistVenueMatch = vi.fn(async (_signalId: string, _result: VenueMatchResult, _detectedAtMs: number, _sourceTimestampIso: string) => ({ matchId: "m1", scheduled: 0, downgradeSkipped: false }));
    const summary = await runSportsShadowCycle(enabledConfig(), baseDeps({ workerRepo, persistVenueMatch: persistVenueMatch as never }));

    // PMUS batch is saturated with old rows (never reaches the newer signal -- it isn't even PMUS-pending).
    expect(summary.sourceLane?.pmus.pendingFound).toBe(20);
    // Kalshi's independent query DOES find and resolve the newer signal despite PMUS's backlog.
    const kalshiCalls = persistVenueMatch.mock.calls.filter((c) => (c[1] as VenueMatchResult).venue === "KALSHI");
    expect(kalshiCalls.some((c) => c[0] === "newer-kalshi-only")).toBe(true);
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

  it("Task 12I / P2-P3: a Kalshi discovery TRUNCATION failure (the new fail-closed error kalshi.server.ts's paginate now throws) is handled exactly like any other discovery failure -- discoveryFailed=true, no false NONE persisted, venue remains retryable, and PM-US proceeds independently", async () => {
    const workerRepo = makeFakeWorkerRepo([signalRow()], []);
    const discoverKalshi = vi.fn(async () => {
      throw new Error("Kalshi discovery truncated: MAX_PAGES_PER_SERIES (10) exhausted while the final page still carried a non-empty continuation cursor -- catalog is incomplete, refusing to return/cache a partial result");
    });
    const persistVenueMatch = vi.fn(async (_signalId: string, _result: VenueMatchResult, _detectedAtMs: number, _sourceTimestampIso: string) => ({ matchId: "m1", scheduled: 0, downgradeSkipped: false }));
    const summary = await runSportsShadowCycle(enabledConfig(), baseDeps({ workerRepo, discoverKalshi, persistVenueMatch: persistVenueMatch as never }));
    expect(summary.sourceLane?.kalshi.discoveryFailed).toBe(true);
    expect(summary.sourceLane?.kalshi.attempted).toBe(0);
    const kalshiCalls = persistVenueMatch.mock.calls.filter((c) => (c[1] as VenueMatchResult).venue === "KALSHI");
    expect(kalshiCalls).toHaveLength(0); // never persisted as NONE, not persisted at all -- remains retryable next cycle
    const pmusCalls = persistVenueMatch.mock.calls.filter((c) => (c[1] as VenueMatchResult).venue === "PMUS");
    expect(pmusCalls).toHaveLength(1); // PM-US proceeds independently, unaffected by Kalshi's truncated catalog
  });

  it("Task 12I / P2-P3: a PM-US discovery TRUNCATION failure (the new fail-closed error pmus.server.ts's discoverPmusMlbMarkets now throws) is handled exactly like any other discovery failure -- discoveryFailed=true, no false NONE persisted, venue remains retryable, and Kalshi proceeds independently", async () => {
    const workerRepo = makeFakeWorkerRepo([signalRow()], []);
    const discoverPmus = vi.fn(async () => {
      throw new Error("PM-US discovery truncated: DISCOVERY_MAX_PAGES (10) exhausted while the final page was still full (200 events) -- completeness unproven, refusing to return/cache a partial catalog");
    });
    const persistVenueMatch = vi.fn(async (_signalId: string, _result: VenueMatchResult, _detectedAtMs: number, _sourceTimestampIso: string) => ({ matchId: "m1", scheduled: 0, downgradeSkipped: false }));
    const summary = await runSportsShadowCycle(enabledConfig(), baseDeps({ workerRepo, discoverPmus, persistVenueMatch: persistVenueMatch as never }));
    expect(summary.sourceLane?.pmus.discoveryFailed).toBe(true);
    expect(summary.sourceLane?.pmus.attempted).toBe(0);
    const pmusCalls = persistVenueMatch.mock.calls.filter((c) => (c[1] as VenueMatchResult).venue === "PMUS");
    expect(pmusCalls).toHaveLength(0);
    const kalshiCalls = persistVenueMatch.mock.calls.filter((c) => (c[1] as VenueMatchResult).venue === "KALSHI");
    expect(kalshiCalls).toHaveLength(1); // Kalshi proceeds independently, unaffected by PM-US's truncated catalog
  });

  it("20. a genuine semantic NONE from the resolver (successful discovery, no matching candidate) IS persisted", async () => {
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
    expect(summary.sourceLane?.pmus.pendingProcessed).toBe(1); // only the good one, per venue
    expect(summary.sourceLane?.kalshi.pendingProcessed).toBe(1);
    expect(persistVenueMatch).toHaveBeenCalledTimes(2); // sig-good x 2 venues
  });
});

describe("runSportsShadowCycle — Task 12F/P1-G: lease loss stops the source lane", () => {
  it("G8: lease loss during a wallet poll stops remaining wallets AND both venues' pending resolution for that source cycle", async () => {
    const attemptedWallets: string[] = [];
    const pollSportsShadowWallet = vi.fn(async (wallet: string) => {
      attemptedWallets.push(wallet);
      if (wallet === WALLET_A) return emptyWalletResult(wallet, { leaseLost: true });
      return emptyWalletResult(wallet);
    });
    const discoverPmus = vi.fn(async () => [] as PmusCandidate[]);
    const discoverKalshi = vi.fn(async () => [] as KalshiCandidate[]);
    const summary = await runSportsShadowCycle(
      enabledConfig({ wallets: [WALLET_A, WALLET_B, WALLET_C] }),
      baseDeps({ pollSportsShadowWallet: pollSportsShadowWallet as never, discoverPmus, discoverKalshi }),
    );
    expect(attemptedWallets).toEqual([WALLET_A]); // WALLET_B/WALLET_C never attempted
    expect(summary.sourceLane?.leaseLost).toBe(true);
    expect(discoverPmus).not.toHaveBeenCalled();
    expect(discoverKalshi).not.toHaveBeenCalled();
    expect(summary.sourceLane?.pmus.pendingFound).toBe(0);
    expect(summary.sourceLane?.kalshi.pendingFound).toBe(0);
  });

  it("G9: the observation lanes run and complete independently even when the source lane reports lease loss", async () => {
    const pollSportsShadowWallet = vi.fn(async (wallet: string) => emptyWalletResult(wallet, { leaseLost: true }));
    const takeDueSportsShadowObservations = vi.fn(async () => ({ captured: 1, failed: 0, skipped: 0 }));
    const summary = await runSportsShadowCycle(
      enabledConfig({ wallets: [WALLET_A, WALLET_B] }),
      baseDeps({ pollSportsShadowWallet: pollSportsShadowWallet as never, takeDueSportsShadowObservations: takeDueSportsShadowObservations as never }),
    );
    expect(summary.sourceLane?.leaseLost).toBe(true);
    expect(summary.observationLane.pmus.acquired).toBe(true);
    expect(summary.observationLane.pmus.captured).toBe(1);
    expect(summary.observationLane.kalshi.acquired).toBe(true);
    expect(summary.observationLane.kalshi.captured).toBe(1);
  });

  it("a source lane that never loses the lease reports leaseLost=false", async () => {
    const summary = await runSportsShadowCycle(enabledConfig({ wallets: [WALLET_A] }), baseDeps());
    expect(summary.sourceLane?.leaseLost).toBe(false);
  });
});

describe("runSportsShadowCycle — final +0 observation pass", () => {
  it("23. a final observation pass runs after the source lane and can capture a newly-due +0 row", async () => {
    // Task 12H/P1-N: per-venue call counters -- each venue's OWN 1st call is always its
    // main pass and 2nd call is always its final pass, regardless of PMUS/KALSHI
    // cross-venue interleaving (the main pass's Promise.all is fully awaited before the
    // final pass ever starts).
    const callCounts: Record<string, number> = {};
    const takeDueSportsShadowObservations = vi.fn(async (venue: Venue) => {
      callCounts[venue] = (callCounts[venue] ?? 0) + 1;
      return callCounts[venue] === 1 ? { captured: 0, failed: 0, skipped: 0 } : { captured: 1, failed: 0, skipped: 0 };
    });
    const summary = await runSportsShadowCycle(enabledConfig(), baseDeps({ takeDueSportsShadowObservations: takeDueSportsShadowObservations as never }));
    expect(takeDueSportsShadowObservations).toHaveBeenCalledTimes(4); // 2 venues x (main + final)
    expect(summary.finalObservationPass.pmus.captured).toBe(1);
    expect(summary.finalObservationPass.kalshi.captured).toBe(1);
  });

  it("24. a held observation lease causes that venue's final +0 pass to skip without waiting, independently of the other venue", async () => {
    const { repo: leaseRepo } = makeFakeLeaseRepo();
    const takeDueSportsShadowObservations = vi.fn(async () => emptyObservationCollectionResult());
    // Simulate: after lane A releases, something else grabs the PM-US observation lock
    // specifically before the final pass.
    const originalRelease = leaseRepo.release.bind(leaseRepo);
    let pmusAcquireCount = 0;
    const wrappedRepo: SportsLeaseRepository = {
      acquire: async (lockId, workerId, leaseSeconds) => {
        if (lockId === OBSERVATION_LOCK_ID_PMUS) {
          pmusAcquireCount += 1;
          if (pmusAcquireCount === 2) return null; // second (final-pass) attempt finds it held
        }
        return leaseRepo.acquire(lockId, workerId, leaseSeconds);
      },
      release: originalRelease,
      renew: leaseRepo.renew.bind(leaseRepo),
    };
    const summary = await runSportsShadowCycle(enabledConfig(), baseDeps({ leaseRepo: wrappedRepo, takeDueSportsShadowObservations: takeDueSportsShadowObservations as never }));
    expect(summary.finalObservationPass.pmus.acquired).toBe(false);
    expect(summary.finalObservationPass.kalshi.acquired).toBe(true); // independent -- unaffected by PM-US's held lock
    expect(takeDueSportsShadowObservations).toHaveBeenCalledTimes(3); // PMUS main + KALSHI main + KALSHI final (PMUS final never ran)
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
    const takeDueSportsShadowObservations = vi.fn(async (_venue: Venue, _deps: unknown, _maxRows: number, _deadlineAtMs: number | null) => ({ captured: 0, failed: 0, skipped: 0 }));
    await runSportsShadowCycle(enabledConfig(), baseDeps({ takeDueSportsShadowObservations: takeDueSportsShadowObservations as never, now: () => FIXED_NOW_MS }));
    // Task 12H/P1-N: the first TWO calls are the main pass (one per venue, bounded
    // two-call concurrency) -- both must share the identical computed deadline,
    // regardless of which venue's call happens to land first.
    const mainPassCalls = takeDueSportsShadowObservations.mock.calls.slice(0, 2);
    expect(mainPassCalls).toHaveLength(2);
    for (const call of mainPassCalls) expect(call[3]).toBe(FIXED_NOW_MS + OBSERVATION_STAGE_DEADLINE_MS);
  });

  it("passes a shorter deadline into the final +0 catch pass so it cannot itself become a second long hold", async () => {
    const FIXED_NOW_MS = 1_700_000_000_000;
    const takeDueSportsShadowObservations = vi.fn(async (_venue: Venue, _deps: unknown, _maxRows: number, _deadlineAtMs: number | null) => ({ captured: 0, failed: 0, skipped: 0 }));
    await runSportsShadowCycle(enabledConfig(), baseDeps({ takeDueSportsShadowObservations: takeDueSportsShadowObservations as never, now: () => FIXED_NOW_MS }));
    // The LAST two calls are the final +0 catch pass (one per venue) -- the main pass's
    // Promise.all is fully awaited before the final pass ever starts, so this ordering
    // is guaranteed regardless of intra-pass PMUS/KALSHI race.
    const finalPassCalls = takeDueSportsShadowObservations.mock.calls.slice(2, 4);
    expect(finalPassCalls).toHaveLength(2);
    for (const call of finalPassCalls) expect(call[3]).toBe(FIXED_NOW_MS + FINAL_OBSERVATION_STAGE_DEADLINE_MS_FOR_TEST);
    expect(FINAL_OBSERVATION_STAGE_DEADLINE_MS_FOR_TEST).toBeLessThan(OBSERVATION_STAGE_DEADLINE_MS);
  });

  it("work left unstarted by a bounded observation pass stays durable (still due) for a later invocation, which can then acquire the lane once the lease is released", async () => {
    const { repo: leaseRepo } = makeFakeLeaseRepo();
    // First cycle: simulate a bounded pass that only got through some of the batch (this
    // module never sees per-row detail, only the aggregate result Task 8 returns).
    const takeDueSportsShadowObservationsFirst = vi.fn(async () => ({ captured: 2, failed: 0, skipped: 0 }));
    const first = await runSportsShadowCycle(enabledConfig(), baseDeps({ leaseRepo, takeDueSportsShadowObservations: takeDueSportsShadowObservationsFirst as never }));
    expect(first.observationLane.pmus.acquired).toBe(true);
    expect(first.observationLane.kalshi.acquired).toBe(true);

    // A later invocation, sharing the SAME lease repo, can immediately acquire the
    // observation lanes again -- the first cycle's clean release did not leave them locked.
    const takeDueSportsShadowObservationsSecond = vi.fn(async () => ({ captured: 3, failed: 0, skipped: 0 }));
    const second = await runSportsShadowCycle(enabledConfig(), baseDeps({ leaseRepo, takeDueSportsShadowObservations: takeDueSportsShadowObservationsSecond as never }));
    expect(second.observationLane.pmus.acquired).toBe(true);
    expect(second.observationLane.pmus.captured).toBe(3);
    expect(second.observationLane.kalshi.acquired).toBe(true);
    expect(second.observationLane.kalshi.captured).toBe(3);
  });

  it("source lane remains fully independent of the observation-lane timing fix (still acquires/runs normally)", async () => {
    const pollSportsShadowWallet = vi.fn(async (wallet: string) => emptyWalletResult(wallet));
    const summary = await runSportsShadowCycle(enabledConfig(), baseDeps({ pollSportsShadowWallet: pollSportsShadowWallet as never }));
    expect(summary.sourceLane?.acquired).toBe(true);
    expect(pollSportsShadowWallet).toHaveBeenCalledTimes(1);
  });
});

/* ======================================================================
 * TASK 13I / P1-S, P1-T: one absolute source-lane deadline bounds venue
 * matching too (not just wallet polling), and PM-US/Kalshi are resolved via
 * fixed two-way Promise.all concurrency so neither can starve the other.
 * ====================================================================== */

async function flushMicrotasks(times = 30): Promise<void> {
  for (let i = 0; i < times; i += 1) await Promise.resolve();
}

describe("Task 13I / P1-S: resolveVenuePending deadline semantics", () => {
  it("S1: wallet-polling work that consumes the ENTIRE lane budget leaves PM-US/Kalshi unable to start any new discovery/persistence work this cycle", async () => {
    const workerRepo = makeFakeWorkerRepo([signalRow()], []);
    let now = 1_700_000_100_000;
    const pollSportsShadowWallet = vi.fn(async (wallet: string) => {
      now += 31_000; // consumes the whole SOURCE_LANE_BUDGET_MS
      return emptyWalletResult(wallet);
    });
    const discoverPmus = vi.fn(async () => [] as PmusCandidate[]);
    const discoverKalshi = vi.fn(async () => [] as KalshiCandidate[]);
    const persistVenueMatch = vi.fn(async () => ({ matchId: "m", scheduled: 0, downgradeSkipped: false }));
    const summary = await runSportsShadowCycle(
      enabledConfig(),
      baseDeps({
        workerRepo,
        pollSportsShadowWallet: pollSportsShadowWallet as never,
        discoverPmus: discoverPmus as never,
        discoverKalshi: discoverKalshi as never,
        persistVenueMatch: persistVenueMatch as never,
        now: () => now,
      }),
    );
    expect(discoverPmus).not.toHaveBeenCalled();
    expect(discoverKalshi).not.toHaveBeenCalled();
    expect(persistVenueMatch).not.toHaveBeenCalled();
    expect(summary.sourceLane?.pmus.deadlineReached).toBe(true);
    expect(summary.sourceLane?.kalshi.deadlineReached).toBe(true);
    expect(summary.sourceLane?.pmus.discoveryFailed).toBe(false); // S9: never fabricated as a real failure
    expect(summary.sourceLane?.kalshi.discoveryFailed).toBe(false);
  });

  it("S2: when the deadline is already reached before resolveVenuePending's own pending query, zero query/discovery/persistence occurs for either venue", async () => {
    const findPendingSignalsForVenue = vi.fn(async () => []);
    const workerRepo: WorkerRepository = {
      findPendingSignalsForVenue: findPendingSignalsForVenue as never,
      getWalletCursor: async () => 0,
      setWalletCursor: async () => {},
    };
    let now = 1_700_000_100_000;
    const pollSportsShadowWallet = vi.fn(async (wallet: string) => {
      now += 31_000; // deadline already gone before venue resolution even starts
      return emptyWalletResult(wallet);
    });
    const discoverPmus = vi.fn(async () => [] as PmusCandidate[]);
    const discoverKalshi = vi.fn(async () => [] as KalshiCandidate[]);
    await runSportsShadowCycle(
      enabledConfig(),
      baseDeps({
        workerRepo,
        pollSportsShadowWallet: pollSportsShadowWallet as never,
        discoverPmus: discoverPmus as never,
        discoverKalshi: discoverKalshi as never,
        now: () => now,
      }),
    );
    expect(findPendingSignalsForVenue).not.toHaveBeenCalled();
    expect(discoverPmus).not.toHaveBeenCalled();
    expect(discoverKalshi).not.toHaveBeenCalled();
  });

  it("S3: a deadline reached DURING resolveVenuePending's own pending query (query itself completes and reports what it found) still stops before discovery for either venue", async () => {
    let now = 1_700_000_100_000;
    const baseRepo = makeFakeWorkerRepo([signalRow()], []);
    const workerRepo: WorkerRepository = {
      ...baseRepo,
      async findPendingSignalsForVenue(venue, limit) {
        const result = await baseRepo.findPendingSignalsForVenue(venue, limit);
        now += 31_000; // the query's own round trip is what crosses the shared deadline
        return result;
      },
    };
    const discoverPmus = vi.fn(async () => [] as PmusCandidate[]);
    const discoverKalshi = vi.fn(async () => [] as KalshiCandidate[]);
    const summary = await runSportsShadowCycle(
      enabledConfig(),
      baseDeps({ workerRepo, discoverPmus: discoverPmus as never, discoverKalshi: discoverKalshi as never, now: () => now }),
    );
    expect(discoverPmus).not.toHaveBeenCalled();
    expect(discoverKalshi).not.toHaveBeenCalled();
    expect(summary.sourceLane?.pmus.deadlineReached).toBe(true);
    expect(summary.sourceLane?.kalshi.deadlineReached).toBe(true);
    expect(summary.sourceLane?.pmus.pendingFound).toBe(1); // the query itself DID complete and report what it found
  });

  it("S4/S6: a deadline reached during (or immediately after) PM-US discovery discards the partial catalog -- ZERO PM-US persistence across BOTH pending signals, PM-US left retryable, never marked discoveryFailed", async () => {
    const sigA = signalRow({ id: "sig-a" });
    const sigB = signalRow({ id: "sig-b", createdAtIso: "2026-08-19T00:00:01.000Z" });
    const workerRepo = makeFakeWorkerRepo([sigA, sigB], []);
    let now = 1_700_000_100_000;
    const discoverPmus = vi.fn(async () => {
      now += 31_000; // discovery itself consumes the remaining budget
      return [{ marketSlug: "whatever" } as PmusCandidate];
    });
    const discoverKalshi = vi.fn(async () => [] as KalshiCandidate[]);
    const persistVenueMatch = vi.fn(async (signalId: string) => ({ matchId: `m-${signalId}`, scheduled: 0, downgradeSkipped: false }));
    const summary = await runSportsShadowCycle(
      enabledConfig(),
      baseDeps({
        workerRepo,
        discoverPmus: discoverPmus as never,
        discoverKalshi: discoverKalshi as never,
        persistVenueMatch: persistVenueMatch as never,
        now: () => now,
      }),
    );
    expect(persistVenueMatch).not.toHaveBeenCalled();
    expect(summary.sourceLane?.pmus.deadlineReached).toBe(true);
    expect(summary.sourceLane?.pmus.discoveryFailed).toBe(false);
    expect(summary.sourceLane?.pmus.attempted).toBe(0);
    expect(summary.sourceLane?.pmus.pendingProcessed).toBe(0);
  });

  it("S5: a deadline reached during Kalshi discovery discards the partial catalog -- zero Kalshi persistence, Kalshi left retryable, never marked discoveryFailed (mirror of S4 for the other venue)", async () => {
    const workerRepo = makeFakeWorkerRepo([signalRow()], []);
    let now = 1_700_000_100_000;
    const discoverPmus = vi.fn(async () => [] as PmusCandidate[]);
    const discoverKalshi = vi.fn(async () => {
      now += 31_000;
      return [{ marketTicker: "whatever" } as KalshiCandidate];
    });
    const persistVenueMatch = vi.fn(async (signalId: string) => ({ matchId: `m-${signalId}`, scheduled: 0, downgradeSkipped: false }));
    const summary = await runSportsShadowCycle(
      enabledConfig(),
      baseDeps({
        workerRepo,
        discoverPmus: discoverPmus as never,
        discoverKalshi: discoverKalshi as never,
        persistVenueMatch: persistVenueMatch as never,
        now: () => now,
      }),
    );
    expect(summary.sourceLane?.kalshi.deadlineReached).toBe(true);
    expect(summary.sourceLane?.kalshi.discoveryFailed).toBe(false);
    expect(summary.sourceLane?.kalshi.attempted).toBe(0);
  });

  it("S7/S8: a deadline reached BETWEEN two pending signals leaves the already-persisted signal's REAL result valid and the remaining signal completely untouched -- never a fabricated second NONE", async () => {
    const sigA = signalRow({ id: "sig-a" });
    const sigB = signalRow({ id: "sig-b", createdAtIso: "2026-08-19T00:00:01.000Z" });
    // Kalshi already has both signals matched -- isolates this test's per-signal-loop
    // timing assertion to PM-US alone, avoiding any cross-venue Promise.all interleaving
    // ambiguity in a shared persistVenueMatch mock.
    const workerRepo = makeFakeWorkerRepo(
      [sigA, sigB],
      [
        { signalId: sigA.id, venue: "KALSHI" },
        { signalId: sigB.id, venue: "KALSHI" },
      ],
    );
    let now = 1_700_000_100_000;
    const persistVenueMatch = vi.fn(async (signalId: string) => {
      if (signalId === sigA.id) now += 31_000; // sig-a's OWN persistence is what crosses the shared deadline
      return { matchId: `m-${signalId}`, scheduled: 0, downgradeSkipped: false };
    });
    const discoverPmus = vi.fn(async () => [] as PmusCandidate[]); // no candidates -> resolvePmusMatch's real result is NONE
    const discoverKalshi = vi.fn(async () => [] as KalshiCandidate[]);
    const summary = await runSportsShadowCycle(
      enabledConfig(),
      baseDeps({
        workerRepo,
        discoverPmus: discoverPmus as never,
        discoverKalshi: discoverKalshi as never,
        persistVenueMatch: persistVenueMatch as never,
        now: () => now,
      }),
    );
    expect(summary.sourceLane?.pmus.pendingFound).toBe(2);
    expect(summary.sourceLane?.pmus.pendingProcessed).toBe(1); // only sig-a
    expect(summary.sourceLane?.pmus.attempted).toBe(1);
    expect(summary.sourceLane?.pmus.deadlineReached).toBe(true);
    expect(persistVenueMatch).toHaveBeenCalledTimes(1); // sig-b never reached persistence
    // S8: sig-a's REAL resolver result (no discovered candidates -> NONE) is the only NONE
    // tallied -- sig-b is never evaluated and never fabricated as a second NONE merely
    // because the scheduler's own deadline expired.
    expect(summary.sourceLane?.pmus.none).toBe(1);
    expect(summary.sourceLane?.kalshi.pendingFound).toBe(0);
  });

  it("S10 / V5 / V7: a lease steal detected mid-cycle sets leaseLost (never deadlineReached) consistently for BOTH venues sharing the SAME checkpoint/fence -- lease loss and deadline exhaustion are never conflated, and neither venue's detection corrupts the other's", async () => {
    const { repo: leaseRepo, rows } = makeFakeLeaseRepo();
    const workerRepo = makeFakeWorkerRepo([signalRow()], []);
    let now = 1_700_000_100_000;
    let stolen = false;
    const pollSportsShadowWallet = vi.fn(async (wallet: string) => {
      // Exceeds LEASE_RENEWAL_MARGIN_MS (20s) so the NEXT checkpoint() call performs a
      // real renew RPC, but stays under SOURCE_LANE_BUDGET_MS (30s) so the shared
      // deadline itself is not yet reached.
      now += 21_000;
      if (!stolen) {
        const existing = rows.get(SOURCE_LOCK_ID)!;
        rows.set(SOURCE_LOCK_ID, { ...existing, workerId: "attacker", fence: existing.fence + 1 });
        stolen = true;
      }
      return emptyWalletResult(wallet);
    });
    const discoverPmus = vi.fn(async () => [] as PmusCandidate[]);
    const discoverKalshi = vi.fn(async () => [] as KalshiCandidate[]);
    const summary = await runSportsShadowCycle(
      enabledConfig(),
      baseDeps({
        leaseRepo,
        workerRepo,
        pollSportsShadowWallet: pollSportsShadowWallet as never,
        discoverPmus: discoverPmus as never,
        discoverKalshi: discoverKalshi as never,
        now: () => now,
      }),
    );
    expect(summary.sourceLane?.pmus.leaseLost).toBe(true);
    expect(summary.sourceLane?.kalshi.leaseLost).toBe(true);
    expect(summary.sourceLane?.pmus.deadlineReached).toBe(false);
    expect(summary.sourceLane?.kalshi.deadlineReached).toBe(false);
    expect(discoverPmus).not.toHaveBeenCalled();
    expect(discoverKalshi).not.toHaveBeenCalled();
  });

  it("Task 13I / P1-S: discoverPmus/discoverKalshi both receive the SAME laneDeadlineAtMs (Section 2 -- one absolute lane deadline, never a fresh per-venue budget)", async () => {
    const workerRepo = makeFakeWorkerRepo([signalRow()], []);
    const fixedNow = 1_700_000_000_000;
    const discoverPmus = vi.fn(async (_deps: unknown, _deadlineAtMs?: number) => [] as PmusCandidate[]);
    const discoverKalshi = vi.fn(async (_deps: unknown, _deadlineAtMs?: number) => [] as KalshiCandidate[]);
    await runSportsShadowCycle(
      enabledConfig(),
      baseDeps({ workerRepo, discoverPmus: discoverPmus as never, discoverKalshi: discoverKalshi as never, now: () => fixedNow }),
    );
    expect(discoverPmus.mock.calls[0]?.[1]).toBe(fixedNow + SOURCE_LANE_BUDGET_MS);
    expect(discoverKalshi.mock.calls[0]?.[1]).toBe(fixedNow + SOURCE_LANE_BUDGET_MS);
  });
});

describe("Task 13I / Section 4: PM-US/Kalshi venue independence under exactly-two-way concurrency", () => {
  it("V1: a PM-US discovery call that has not yet resolved does not prevent Kalshi's OWN discovery from starting", async () => {
    const workerRepo = makeFakeWorkerRepo([signalRow()], []);
    let pmusStarted = false;
    let kalshiStarted = false;
    let resolvePmusDiscovery!: (v: PmusCandidate[]) => void;
    const discoverPmus = vi.fn(() => {
      pmusStarted = true;
      return new Promise<PmusCandidate[]>((resolve) => {
        resolvePmusDiscovery = resolve;
      });
    });
    const discoverKalshi = vi.fn(async () => {
      kalshiStarted = true;
      return [] as KalshiCandidate[];
    });
    const cyclePromise = runSportsShadowCycle(
      enabledConfig(),
      baseDeps({ workerRepo, discoverPmus: discoverPmus as never, discoverKalshi: discoverKalshi as never }),
    );
    await flushMicrotasks();
    expect(pmusStarted).toBe(true);
    expect(kalshiStarted).toBe(true); // started WITHOUT waiting for PM-US's still-unresolved discovery
    resolvePmusDiscovery([]);
    await cyclePromise;
  });

  it("V2: a Kalshi discovery call that has not yet resolved does not prevent PM-US's OWN discovery from starting (mirror of V1)", async () => {
    const workerRepo = makeFakeWorkerRepo([signalRow()], []);
    let pmusStarted = false;
    let kalshiStarted = false;
    let resolveKalshiDiscovery!: (v: KalshiCandidate[]) => void;
    const discoverPmus = vi.fn(async () => {
      pmusStarted = true;
      return [] as PmusCandidate[];
    });
    const discoverKalshi = vi.fn(() => {
      kalshiStarted = true;
      return new Promise<KalshiCandidate[]>((resolve) => {
        resolveKalshiDiscovery = resolve;
      });
    });
    const cyclePromise = runSportsShadowCycle(
      enabledConfig(),
      baseDeps({ workerRepo, discoverPmus: discoverPmus as never, discoverKalshi: discoverKalshi as never }),
    );
    await flushMicrotasks();
    expect(kalshiStarted).toBe(true);
    expect(pmusStarted).toBe(true);
    resolveKalshiDiscovery([]);
    await cyclePromise;
  });

  it("V3: PM-US completing normally (persisting a match) does not require Kalshi to also complete -- Kalshi can independently hit the shared deadline in the SAME cycle", async () => {
    const workerRepo = makeFakeWorkerRepo([signalRow()], []);
    let now = 1_700_000_100_000;
    const discoverPmus = vi.fn(async () => [] as PmusCandidate[]);
    let resolveKalshiDiscovery!: (v: KalshiCandidate[]) => void;
    const discoverKalshi = vi.fn(
      () =>
        new Promise<KalshiCandidate[]>((resolve) => {
          resolveKalshiDiscovery = resolve;
        }),
    );
    const persistVenueMatch = vi.fn(async (signalId: string) => ({ matchId: `m-${signalId}`, scheduled: 0, downgradeSkipped: false }));
    const cyclePromise = runSportsShadowCycle(
      enabledConfig(),
      baseDeps({
        workerRepo,
        discoverPmus: discoverPmus as never,
        discoverKalshi: discoverKalshi as never,
        persistVenueMatch: persistVenueMatch as never,
        now: () => now,
      }),
    );
    await flushMicrotasks(); // let PM-US's entire (fast, no real delay) chain fully settle
    expect(persistVenueMatch).toHaveBeenCalled(); // PM-US already persisted while Kalshi's discovery is still pending
    now += 31_000; // NOW push the shared clock past the lane deadline
    resolveKalshiDiscovery([]);
    const summary = await cyclePromise;
    expect(summary.sourceLane?.kalshi.deadlineReached).toBe(true);
    expect(summary.sourceLane?.pmus.attempted ?? 0).toBeGreaterThan(0);
  });

  it("V4: a PM-US discovery failure (throws) leaves Kalshi's OWN resolution completely independent -- Kalshi still discovers and persists normally", async () => {
    const workerRepo = makeFakeWorkerRepo([signalRow()], []);
    const discoverPmus = vi.fn(async () => {
      throw new Error("PM-US exploded");
    });
    const discoverKalshi = vi.fn(async () => [] as KalshiCandidate[]);
    const persistVenueMatch = vi.fn(async (signalId: string) => ({ matchId: `m-${signalId}`, scheduled: 0, downgradeSkipped: false }));
    const summary = await runSportsShadowCycle(
      enabledConfig(),
      baseDeps({
        workerRepo,
        discoverPmus: discoverPmus as never,
        discoverKalshi: discoverKalshi as never,
        persistVenueMatch: persistVenueMatch as never,
      }),
    );
    expect(summary.sourceLane?.pmus.discoveryFailed).toBe(true);
    expect(summary.sourceLane?.pmus.deadlineReached).toBe(false);
    expect(summary.sourceLane?.kalshi.discoveryFailed).toBe(false);
    expect(summary.sourceLane?.kalshi.attempted).toBeGreaterThan(0);
  });

  it("V6: PM-US and Kalshi resolution run with EXACTLY two-way concurrency -- both discovery calls are genuinely in flight at the same time, never sequential (PM-US-then-Kalshi)", async () => {
    const workerRepo = makeFakeWorkerRepo([signalRow()], []);
    let concurrent = 0;
    let maxConcurrent = 0;
    function makeDiscover<T>(): () => Promise<T[]> {
      return async () => {
        concurrent += 1;
        maxConcurrent = Math.max(maxConcurrent, concurrent);
        await Promise.resolve();
        concurrent -= 1;
        return [] as T[];
      };
    }
    const discoverPmus = vi.fn(makeDiscover<PmusCandidate>());
    const discoverKalshi = vi.fn(makeDiscover<KalshiCandidate>());
    await runSportsShadowCycle(enabledConfig(), baseDeps({ workerRepo, discoverPmus: discoverPmus as never, discoverKalshi: discoverKalshi as never }));
    expect(discoverPmus).toHaveBeenCalledTimes(1);
    expect(discoverKalshi).toHaveBeenCalledTimes(1);
    expect(maxConcurrent).toBe(2); // both were genuinely in flight at the same time -- true concurrency, not sequential
  });
});

describe("FINAL BUILD Parts 25/27: onCycleComplete telemetry/alert hook", () => {
  it("is called exactly once per ENABLED cycle with the completed summary", async () => {
    const onCycleComplete = vi.fn(async () => {});
    const summary = await runSportsShadowCycle(enabledConfig(), baseDeps({ onCycleComplete }));
    expect(onCycleComplete).toHaveBeenCalledTimes(1);
    expect(onCycleComplete).toHaveBeenCalledWith(summary);
  });

  it("is NEVER called when the config is disabled -- no telemetry/alert side effects from a disabled cycle", async () => {
    const onCycleComplete = vi.fn(async () => {});
    await runSportsShadowCycle({ enabled: false, wallets: [], goLiveAtMs: null, gitSha: "test-sha" }, baseDeps({ onCycleComplete }));
    expect(onCycleComplete).not.toHaveBeenCalled();
  });

  it("a throwing onCycleComplete never propagates -- the cycle's own summary is still returned normally", async () => {
    const onCycleComplete = vi.fn(async () => {
      throw new Error("telemetry backend down");
    });
    const summary = await runSportsShadowCycle(enabledConfig(), baseDeps({ onCycleComplete }));
    expect(summary.configEnabled).toBe(true);
    expect(summary.errors).toEqual([]); // the hook's own failure never leaks into the cycle's reported errors
  });
});
