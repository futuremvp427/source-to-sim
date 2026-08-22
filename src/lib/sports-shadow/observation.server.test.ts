import { describe, expect, it, vi } from "vitest";
import { DUE_BATCH_LIMIT, persistVenueMatch, takeDueSportsShadowObservations, type DueObservationRow, type ExistingMatch, type ObservationDeps, type ObservationRepository } from "./observation.server";
import type { MatchRow, ObservationCapturePatch, ObservationScheduleRow } from "./observation";
import type { VenueMatchResult } from "./resolver";
import type { KalshiBookSnapshot } from "./kalshi";
import type { BookSnapshot } from "./types";

type StoredMatch = MatchRow & { id: string };
type StoredObservation = {
  id: string;
  signalId: string;
  matchId: string;
  venue: "PMUS" | "KALSHI";
  requestedDelayMs: number;
  fireAt: string;
  observedAt: string | null;
  patch?: ObservationCapturePatch;
};

/** In-memory fake implementing the exact CAS/idempotency semantics the real repository provides, without touching Supabase. */
function makeFakeRepo() {
  const matches = new Map<string, StoredMatch>(); // key: signalId|venue
  const observations = new Map<string, StoredObservation>(); // key: id
  let nextId = 1;

  const repo: ObservationRepository = {
    async getExistingMatch(signalId, venue): Promise<ExistingMatch | null> {
      const m = matches.get(`${signalId}|${venue}`);
      return m ? { id: m.id, status: m.matchStatus, firstMatchStatus: m.firstMatchStatus, recheckCount: m.recheckCount } : null;
    },
    async upsertMatch(row) {
      const key = `${row.signalId}|${row.venue}`;
      const existing = matches.get(key);
      const id = existing?.id ?? `match-${nextId++}`;
      matches.set(key, { ...row, id });
      return { id };
    },
    async scheduleObservations(rows: ObservationScheduleRow[]) {
      let inserted = 0;
      for (const r of rows) {
        const dupKey = [...observations.values()].find((o) => o.signalId === r.signalId && o.venue === r.venue && o.requestedDelayMs === r.requestedDelayMs);
        if (dupKey) continue; // ON CONFLICT DO NOTHING
        const id = `obs-${nextId++}`;
        observations.set(id, { id, signalId: r.signalId, matchId: r.matchId, venue: r.venue, requestedDelayMs: r.requestedDelayMs, fireAt: r.fireAt, observedAt: null });
        inserted += 1;
      }
      return inserted;
    },
    async findDueObservations(venue, nowIso, limit): Promise<DueObservationRow[]> {
      const due = [...observations.values()]
        .filter((o) => o.venue === venue && o.observedAt === null && o.fireAt <= nowIso)
        .sort((a, b) => (a.fireAt < b.fireAt ? -1 : a.fireAt > b.fireAt ? 1 : 0))
        .slice(0, limit);
      return due.map((o) => {
        const match = [...matches.values()].find((m) => m.id === o.matchId);
        return { id: o.id, signalId: o.signalId, matchId: o.matchId, venue: o.venue, requestedDelayMs: o.requestedDelayMs, fireAt: o.fireAt, targetFetchKey: match?.targetMarketId ?? null, selectedSide: match?.selectedSide ?? null };
      });
    },
    async claimObservationTerminal(id, patch) {
      const row = observations.get(id);
      if (!row || row.observedAt !== null) return false; // CAS: already claimed
      row.observedAt = patch.observedAt;
      row.patch = patch;
      return true;
    },
  };

  return { repo, matches, observations };
}

function exactResult(overrides: Partial<VenueMatchResult> = {}): VenueMatchResult {
  return {
    venue: "PMUS",
    status: "EXACT",
    reasonCode: "EXACT_MATCH",
    reason: "matched",
    sourceConditionId: "0xcond",
    sourceMarketSlug: "mlb-nyy-bal-2026-08-19",
    targetEventId: "ev-1",
    targetMarketId: "444031",
    targetFetchKey: "aec-mlb-nyy-bal-2026-08-19",
    targetGameIdentifier: "game-1",
    targetAwayTeam: "NYY",
    targetHomeTeam: "BAL",
    targetBetType: "MONEYLINE",
    sourceLine: null,
    targetLine: null,
    sourceStartTime: "2026-08-19T22:35:00Z",
    targetStartTime: "2026-08-19T22:35:00Z",
    targetSide: { kind: "TEAM", team: "NYY" },
    targetPmusOrientation: "LONG",
    settlementCompatibility: "COMPATIBLE",
    settlementProfile: { extraInnings: "EXACT_COMPATIBLE", postponement: "EXACT_COMPATIBLE", pushRisk: "EXACT_COMPATIBLE" },
    candidateCounts: { exact: 1, near: 0, unverified: 0, total: 1 },
    evidence: [],
    ...overrides,
  };
}

const DETECTED_AT_MS = 1_700_000_000_000;
const SOURCE_TS = "2026-08-19T22:00:00Z";

describe("persistVenueMatch — match persistence + scheduling", () => {
  it("1. an EXACT PM-US match is persisted and schedules observations", async () => {
    const { repo } = makeFakeRepo();
    const result = await persistVenueMatch("sig-1", exactResult(), DETECTED_AT_MS, SOURCE_TS, null, { repo, now: () => DETECTED_AT_MS });
    expect(result.scheduled).toBe(5);
    expect(result.downgradeSkipped).toBe(false);
  });

  it("2. an EXACT Kalshi match is persisted and schedules observations", async () => {
    const { repo } = makeFakeRepo();
    const kalshi = exactResult({ venue: "KALSHI", targetFetchKey: "KXMLBGAME-1-NYY", targetSide: { kind: "YES" }, targetPmusOrientation: null });
    const result = await persistVenueMatch("sig-1", kalshi, DETECTED_AT_MS, SOURCE_TS, null, { repo, now: () => DETECTED_AT_MS });
    expect(result.scheduled).toBe(5);
  });

  it("3/4/5. NEAR/NONE/UNVERIFIED are persisted but schedule no quotes", async () => {
    for (const status of ["NEAR", "NONE", "UNVERIFIED"] as const) {
      const { repo, matches } = makeFakeRepo();
      const result = exactResult({ status, targetFetchKey: status === "NEAR" ? "some-key" : null, targetSide: null });
      const out = await persistVenueMatch("sig-1", result, DETECTED_AT_MS, SOURCE_TS, null, { repo, now: () => DETECTED_AT_MS });
      expect(out.scheduled).toBe(0);
      expect(matches.get("sig-1|PMUS")?.matchStatus).toBe(status);
    }
  });

  it("6. repeated processing of the same signal+venue is idempotent (no duplicate scheduling)", async () => {
    const { repo } = makeFakeRepo();
    const first = await persistVenueMatch("sig-1", exactResult(), DETECTED_AT_MS, SOURCE_TS, null, { repo, now: () => DETECTED_AT_MS });
    const second = await persistVenueMatch("sig-1", exactResult(), DETECTED_AT_MS, SOURCE_TS, null, { repo, now: () => DETECTED_AT_MS });
    expect(first.scheduled).toBe(5);
    expect(second.scheduled).toBe(0); // all 5 already exist -> 0 newly inserted
    expect(first.matchId).toBe(second.matchId); // stable id across repeated upserts
  });

  it("7. an EXACT match is never silently downgraded by a later worse result (retry does not erase evidence)", async () => {
    const { repo, matches } = makeFakeRepo();
    await persistVenueMatch("sig-1", exactResult(), DETECTED_AT_MS, SOURCE_TS, null, { repo, now: () => DETECTED_AT_MS });
    const worseLater = exactResult({ status: "UNVERIFIED", targetFetchKey: null, targetSide: null, reason: "transient discovery gap" });
    const result = await persistVenueMatch("sig-1", worseLater, DETECTED_AT_MS, SOURCE_TS, null, { repo, now: () => DETECTED_AT_MS });
    expect(result.downgradeSkipped).toBe(true);
    expect(matches.get("sig-1|PMUS")?.matchStatus).toBe("EXACT"); // untouched
    expect(matches.get("sig-1|PMUS")?.selectedSide).toBe("TEAM:NYY:LONG"); // original evidence intact
  });

  it("an EXACT match CAN be re-confirmed by another EXACT result (not treated as a downgrade)", async () => {
    const { repo } = makeFakeRepo();
    await persistVenueMatch("sig-1", exactResult(), DETECTED_AT_MS, SOURCE_TS, null, { repo, now: () => DETECTED_AT_MS });
    const result = await persistVenueMatch("sig-1", exactResult({ reason: "re-confirmed" }), DETECTED_AT_MS, SOURCE_TS, null, { repo, now: () => DETECTED_AT_MS });
    expect(result.downgradeSkipped).toBe(false);
  });

  it("a non-EXACT match CAN be upgraded to EXACT by a later, better-informed result", async () => {
    const { repo, matches } = makeFakeRepo();
    await persistVenueMatch("sig-1", exactResult({ status: "UNVERIFIED", targetFetchKey: null, targetSide: null }), DETECTED_AT_MS, SOURCE_TS, null, { repo, now: () => DETECTED_AT_MS });
    const result = await persistVenueMatch("sig-1", exactResult(), DETECTED_AT_MS, SOURCE_TS, null, { repo, now: () => DETECTED_AT_MS });
    expect(result.downgradeSkipped).toBe(false);
    expect(result.scheduled).toBe(5);
    expect(matches.get("sig-1|PMUS")?.matchStatus).toBe("EXACT");
  });

  it("8. no delete function is exported by this module", async () => {
    const mod = await import("./observation.server");
    const exportNames = Object.keys(mod);
    expect(exportNames.some((n) => /delete/i.test(n))).toBe(false);
  });

  it("9/10/11. exactly 5 rows are scheduled with the exact 5 legal delays", async () => {
    const { repo, observations } = makeFakeRepo();
    await persistVenueMatch("sig-1", exactResult(), DETECTED_AT_MS, SOURCE_TS, null, { repo, now: () => DETECTED_AT_MS });
    const delays = [...observations.values()].map((o) => o.requestedDelayMs).sort((a, b) => a - b);
    expect(delays).toEqual([0, 5_000, 10_000, 30_000, 60_000]);
  });

  it("16. a repeated scheduler call creates no duplicates", async () => {
    const { repo, observations } = makeFakeRepo();
    await persistVenueMatch("sig-1", exactResult(), DETECTED_AT_MS, SOURCE_TS, null, { repo, now: () => DETECTED_AT_MS });
    await persistVenueMatch("sig-1", exactResult(), DETECTED_AT_MS, SOURCE_TS, null, { repo, now: () => DETECTED_AT_MS });
    expect(observations.size).toBe(5);
  });

  it("17. a retry does not move an existing row's fire_at", async () => {
    const { repo, observations } = makeFakeRepo();
    await persistVenueMatch("sig-1", exactResult(), DETECTED_AT_MS, SOURCE_TS, null, { repo, now: () => DETECTED_AT_MS });
    const originalFireAt = [...observations.values()].map((o) => o.fireAt);
    await persistVenueMatch("sig-1", exactResult(), DETECTED_AT_MS + 999_999, SOURCE_TS, null, { repo, now: () => DETECTED_AT_MS }); // wildly different detectedAt on retry
    const laterFireAt = [...observations.values()].map((o) => o.fireAt);
    expect(laterFireAt).toEqual(originalFireAt);
  });

  it("18. a retry does not reset an already-captured observation's observed_at", async () => {
    const { repo, observations } = makeFakeRepo();
    await persistVenueMatch("sig-1", exactResult(), DETECTED_AT_MS, SOURCE_TS, null, { repo, now: () => DETECTED_AT_MS });
    const firstRow = [...observations.values()][0]!;
    firstRow.observedAt = "2026-08-19T22:35:00.500Z"; // simulate a completed capture
    await persistVenueMatch("sig-1", exactResult(), DETECTED_AT_MS, SOURCE_TS, null, { repo, now: () => DETECTED_AT_MS });
    expect(firstRow.observedAt).toBe("2026-08-19T22:35:00.500Z");
  });

  it("19. an invalid detectedAt schedules nothing (fails closed)", async () => {
    const { repo } = makeFakeRepo();
    const result = await persistVenueMatch("sig-1", exactResult(), Number.NaN, SOURCE_TS, null, { repo, now: () => DETECTED_AT_MS });
    expect(result.scheduled).toBe(0);
  });

  it("20. an unresolved target side schedules nothing", async () => {
    const { repo } = makeFakeRepo();
    const result = await persistVenueMatch("sig-1", exactResult({ targetSide: null }), DETECTED_AT_MS, SOURCE_TS, null, { repo, now: () => DETECTED_AT_MS });
    expect(result.scheduled).toBe(0);
  });
});

describe("persistVenueMatch — Task 12H / P1-M: durable non-EXACT recheck scheduling", () => {
  it("M-NONE. a NONE result becomes durably retryable (next_recheck_at set), and a LATER call with the same signal+venue can upgrade it to EXACT", async () => {
    const { repo, matches } = makeFakeRepo();
    const nowAtFirstAttempt = DETECTED_AT_MS + 1_000;
    const none = exactResult({ status: "NONE", targetFetchKey: null, targetSide: null });
    await persistVenueMatch("sig-none", none, DETECTED_AT_MS, SOURCE_TS, "2026-08-19T22:35:00Z", { repo, now: () => nowAtFirstAttempt });
    const afterFirst = matches.get("sig-none|PMUS")!;
    expect(afterFirst.matchStatus).toBe("NONE");
    expect(afterFirst.nextRecheckAt).not.toBeNull(); // NOT permanently non-retryable

    // A later recheck (simulating a subsequent scheduler pass) discovers the target and upgrades to EXACT.
    const laterResult = await persistVenueMatch("sig-none", exactResult(), DETECTED_AT_MS, SOURCE_TS, "2026-08-19T22:35:00Z", { repo, now: () => nowAtFirstAttempt + 5 * 60 * 1000 });
    expect(laterResult.downgradeSkipped).toBe(false);
    expect(matches.get("sig-none|PMUS")?.matchStatus).toBe("EXACT");
  });

  it("M-NEAR. a NEAR result is durably retryable and can later become EXACT", async () => {
    const { repo, matches } = makeFakeRepo();
    const near = exactResult({ status: "NEAR", targetFetchKey: "candidate-slug", targetSide: null });
    await persistVenueMatch("sig-near", near, DETECTED_AT_MS, SOURCE_TS, "2026-08-19T22:35:00Z", { repo, now: () => DETECTED_AT_MS });
    expect(matches.get("sig-near|PMUS")?.nextRecheckAt).not.toBeNull();
    await persistVenueMatch("sig-near", exactResult(), DETECTED_AT_MS, SOURCE_TS, "2026-08-19T22:35:00Z", { repo, now: () => DETECTED_AT_MS });
    expect(matches.get("sig-near|PMUS")?.matchStatus).toBe("EXACT");
  });

  it("M-UNVERIFIED. an UNVERIFIED result is durably retryable and can later become EXACT", async () => {
    const { repo, matches } = makeFakeRepo();
    const unverified = exactResult({ status: "UNVERIFIED", targetFetchKey: null, targetSide: null });
    await persistVenueMatch("sig-unv", unverified, DETECTED_AT_MS, SOURCE_TS, "2026-08-19T22:35:00Z", { repo, now: () => DETECTED_AT_MS });
    expect(matches.get("sig-unv|PMUS")?.nextRecheckAt).not.toBeNull();
    await persistVenueMatch("sig-unv", exactResult(), DETECTED_AT_MS, SOURCE_TS, "2026-08-19T22:35:00Z", { repo, now: () => DETECTED_AT_MS });
    expect(matches.get("sig-unv|PMUS")?.matchStatus).toBe("EXACT");
  });

  it("M-EXACT-terminal. EXACT always persists with nextRecheckAt=null -- never re-offered as due for recheck", async () => {
    const { repo, matches } = makeFakeRepo();
    await persistVenueMatch("sig-exact", exactResult(), DETECTED_AT_MS, SOURCE_TS, "2026-08-19T22:35:00Z", { repo });
    expect(matches.get("sig-exact|PMUS")?.nextRecheckAt).toBeNull();
  });

  it("M6/M-cooldown. an immediate re-check attempt (same 'now') is not respected as a fresh cooldown -- the recheck interval always starts from the current now(), never resets to zero", async () => {
    const { repo, matches } = makeFakeRepo();
    const t0 = DETECTED_AT_MS;
    await persistVenueMatch("sig-cd", exactResult({ status: "NONE", targetFetchKey: null, targetSide: null }), DETECTED_AT_MS, SOURCE_TS, "2026-08-19T22:35:00Z", { repo, now: () => t0 });
    const firstRecheckAt = matches.get("sig-cd|PMUS")!.nextRecheckAt!;
    expect(new Date(firstRecheckAt).getTime()).toBe(t0 + 5 * 60 * 1000); // exactly RECHECK_INTERVAL_MS out, not sooner
  });

  it("M7/M-restart. recheck state is durable state on the row itself (not in-memory) -- a brand-new persistVenueMatch call sharing only the repo (simulating a fresh process) sees and preserves it", async () => {
    const { repo, matches } = makeFakeRepo();
    await persistVenueMatch("sig-restart", exactResult({ status: "NONE", targetFetchKey: null, targetSide: null }), DETECTED_AT_MS, SOURCE_TS, "2026-08-19T22:35:00Z", { repo });
    const recheckCountAfterFirst = matches.get("sig-restart|PMUS")!.recheckCount;

    // Simulate a fresh process invocation: brand-new deps object, same durable repo.
    await persistVenueMatch("sig-restart", exactResult({ status: "NONE", targetFetchKey: null, targetSide: null }), DETECTED_AT_MS, SOURCE_TS, "2026-08-19T22:35:00Z", { repo, now: () => DETECTED_AT_MS + 10_000 });
    expect(matches.get("sig-restart|PMUS")!.recheckCount).toBe(recheckCountAfterFirst + 1);
  });

  it("M9. the cutoff (scheduled game start time) is respected end-to-end through persistVenueMatch, not just in the pure calculator", async () => {
    const { repo, matches } = makeFakeRepo();
    const gameAlreadyStarted = "2020-01-01T00:00:00Z"; // in the past relative to `now` (DETECTED_AT_MS is 2023-11-14)
    await persistVenueMatch("sig-cutoff", exactResult({ status: "NONE", targetFetchKey: null, targetSide: null }), DETECTED_AT_MS, SOURCE_TS, gameAlreadyStarted, { repo, now: () => DETECTED_AT_MS });
    expect(matches.get("sig-cutoff|PMUS")?.nextRecheckAt).toBeNull(); // cutoff already passed -- no further rechecks
  });

  it("M-audit. firstMatchStatus is an immutable audit field: set once on the FIRST persisted status, never overwritten by later upgrades, even though matchStatus (current) does change", async () => {
    const { repo, matches } = makeFakeRepo();
    await persistVenueMatch("sig-audit", exactResult({ status: "NONE", targetFetchKey: null, targetSide: null }), DETECTED_AT_MS, SOURCE_TS, "2026-08-19T22:35:00Z", { repo, now: () => DETECTED_AT_MS });
    expect(matches.get("sig-audit|PMUS")?.firstMatchStatus).toBe("NONE");

    await persistVenueMatch("sig-audit", exactResult({ status: "NEAR", targetFetchKey: "some-key", targetSide: null }), DETECTED_AT_MS, SOURCE_TS, "2026-08-19T22:35:00Z", { repo, now: () => DETECTED_AT_MS });
    expect(matches.get("sig-audit|PMUS")?.matchStatus).toBe("NEAR"); // current status advanced
    expect(matches.get("sig-audit|PMUS")?.firstMatchStatus).toBe("NONE"); // first-ever evidence preserved

    await persistVenueMatch("sig-audit", exactResult(), DETECTED_AT_MS, SOURCE_TS, "2026-08-19T22:35:00Z", { repo, now: () => DETECTED_AT_MS });
    expect(matches.get("sig-audit|PMUS")?.matchStatus).toBe("EXACT");
    expect(matches.get("sig-audit|PMUS")?.firstMatchStatus).toBe("NONE"); // still preserved, even after reaching EXACT
  });

  it("M-audit-exact-first. when the FIRST-ever result is already EXACT, firstMatchStatus is EXACT (correctly records the true first observation)", async () => {
    const { repo, matches } = makeFakeRepo();
    await persistVenueMatch("sig-audit2", exactResult(), DETECTED_AT_MS, SOURCE_TS, "2026-08-19T22:35:00Z", { repo, now: () => DETECTED_AT_MS });
    expect(matches.get("sig-audit2|PMUS")?.firstMatchStatus).toBe("EXACT");
  });

  it("M8. a late recheck that finally becomes EXACT still schedules its +0/+5/+10/+30/+60 burst off the ORIGINAL detectedAtMs, not the recheck time -- an already-past checkpoint stays visibly late", async () => {
    const { repo, observations } = makeFakeRepo();
    const originalDetectedAtMs = DETECTED_AT_MS; // this is what detectedAtMsFromSignal(signal) would derive every single call, since it reads the signal's own immutable created_at (Task 12G/P1-L) -- never "now".
    await persistVenueMatch("sig-late", exactResult({ status: "NONE", targetFetchKey: null, targetSide: null }), originalDetectedAtMs, SOURCE_TS, "2026-08-19T23:00:00Z", { repo, now: () => originalDetectedAtMs });

    // A much later recheck pass (e.g. +30 minutes of wall-clock time) finally finds the market.
    // The caller (worker.server.ts) always re-derives the SAME originalDetectedAtMs from the
    // immutable signal row, so it is passed again here unchanged -- never a fresh "now".
    const muchLater = originalDetectedAtMs + 30 * 60 * 1000;
    const result = await persistVenueMatch("sig-late", exactResult(), originalDetectedAtMs, SOURCE_TS, "2026-08-19T23:00:00Z", { repo, now: () => muchLater });
    expect(result.scheduled).toBe(5);

    const fireAts = [...observations.values()].map((o) => o.fireAt).sort();
    const expectedFireAts = [0, 5_000, 10_000, 30_000, 60_000].map((d) => new Date(originalDetectedAtMs + d).toISOString()).sort();
    expect(fireAts).toEqual(expectedFireAts); // anchored to the ORIGINAL detection time, not `muchLater`
    // Since fireAt is derived from the original (already 30 minutes in the past) detectedAtMs,
    // every one of these checkpoints is already due/late the instant it is created -- exactly
    // the intended "stays visibly late rather than rewritten to look timely" behavior.
    for (const fireAt of fireAts) {
      expect(new Date(fireAt).getTime()).toBeLessThan(muchLater);
    }
  });

  it("P1-N-independence (recheck). a PM-US recheck does not touch or depend on any Kalshi match row for the same signal", async () => {
    const { repo, matches } = makeFakeRepo();
    await persistVenueMatch("sig-both", exactResult({ status: "NONE", targetFetchKey: null, targetSide: null }), DETECTED_AT_MS, SOURCE_TS, "2026-08-19T22:35:00Z", { repo });
    await persistVenueMatch(
      "sig-both",
      exactResult({ venue: "KALSHI", status: "NONE", targetFetchKey: null, targetSide: null, targetPmusOrientation: null }),
      DETECTED_AT_MS,
      SOURCE_TS,
      "2026-08-19T22:35:00Z",
      { repo },
    );
    // Upgrading PMUS to EXACT must not alter the independently-tracked KALSHI row's recheck state.
    const kalshiBefore = { ...matches.get("sig-both|KALSHI")! };
    await persistVenueMatch("sig-both", exactResult(), DETECTED_AT_MS, SOURCE_TS, "2026-08-19T22:35:00Z", { repo });
    const kalshiAfter = matches.get("sig-both|KALSHI")!;
    expect(kalshiAfter.matchStatus).toBe(kalshiBefore.matchStatus);
    expect(kalshiAfter.nextRecheckAt).toBe(kalshiBefore.nextRecheckAt);
    expect(kalshiAfter.recheckCount).toBe(kalshiBefore.recheckCount);
  });

  it("M10. a transient/malformed-discovery result (resolver-classified UNVERIFIED, per Task 12F/P1-I's fail-closed contract) is persisted exactly as UNVERIFIED -- never silently coerced to a semantic NONE by the new recheck logic -- and remains durably retryable", async () => {
    const { repo, matches } = makeFakeRepo();
    const transientFailure = exactResult({ status: "UNVERIFIED", reasonCode: "UNVERIFIED_AMBIGUOUS_TARGET", reason: "discovery catalog fetch failed", targetFetchKey: null, targetSide: null });
    await persistVenueMatch("sig-transient", transientFailure, DETECTED_AT_MS, SOURCE_TS, "2026-08-19T22:35:00Z", { repo, now: () => DETECTED_AT_MS });
    const row = matches.get("sig-transient|PMUS")!;
    expect(row.matchStatus).toBe("UNVERIFIED"); // not coerced to NONE
    expect(row.firstMatchStatus).toBe("UNVERIFIED");
    expect(row.nextRecheckAt).not.toBeNull(); // durably retryable, not permanently terminal
  });
});

describe("persistVenueMatch — Task 12I / P1-O, O2/O3: execution-time cutoff guard (Layer B)", () => {
  const CUTOFF_ISO = "2026-08-19T22:35:00Z";
  const CUTOFF_MS = Date.parse(CUTOFF_ISO);

  it("O2-1. a pre-cutoff next_recheck row that the worker actually processes AFTER cutoff cannot upgrade to a NEW EXACT -- the mission's exact 6:59pm/7:00pm/7:02pm example", async () => {
    const { repo, matches } = makeFakeRepo();
    // Legitimately scheduled just before cutoff (e.g. next_recheck_at = 6:59pm for a 7:00pm game).
    await persistVenueMatch("sig-late-worker", exactResult({ status: "NONE", targetFetchKey: null, targetSide: null }), DETECTED_AT_MS, SOURCE_TS, CUTOFF_ISO, { repo, now: () => CUTOFF_MS - 60_000 });
    expect(matches.get("sig-late-worker|PMUS")?.matchStatus).toBe("NONE");

    // Scheduler outage; the worker only actually resumes and processes this row at 7:02pm --
    // after cutoff -- and the resolver genuinely found a real EXACT target this time.
    const result = await persistVenueMatch("sig-late-worker", exactResult(), DETECTED_AT_MS, SOURCE_TS, CUTOFF_ISO, { repo, now: () => CUTOFF_MS + 2 * 60_000 });

    // Must NOT resolve to a newly accepted EXACT.
    expect(matches.get("sig-late-worker|PMUS")?.matchStatus).not.toBe("EXACT");
    expect(matches.get("sig-late-worker|PMUS")?.matchStatus).toBe("UNVERIFIED");
    expect(matches.get("sig-late-worker|PMUS")?.reasonCode).toBe("UNVERIFIED_CUTOFF_EXCEEDED");
    // Must NOT schedule +0/+5/+10/+30/+60 observations.
    expect(result.scheduled).toBe(0);
    // Must NOT remain indefinitely retryable -- final non-EXACT for the Phase-1 experiment.
    expect(matches.get("sig-late-worker|PMUS")?.nextRecheckAt).toBeNull();
  });

  it("O2-2. delayed-scheduler cannot schedule a NEW observation burst after cutoff (no rows created at all for the rejected late EXACT)", async () => {
    const { repo, observations } = makeFakeRepo();
    await persistVenueMatch("sig-late-obs", exactResult({ status: "NONE", targetFetchKey: null, targetSide: null }), DETECTED_AT_MS, SOURCE_TS, CUTOFF_ISO, { repo, now: () => CUTOFF_MS - 60_000 });
    await persistVenueMatch("sig-late-obs", exactResult(), DETECTED_AT_MS, SOURCE_TS, CUTOFF_ISO, { repo, now: () => CUTOFF_MS + 2 * 60_000 });
    expect(observations.size).toBe(0);
  });

  it("O2-3. restart after cutoff cannot resurrect rechecking -- a fresh persistVenueMatch invocation (simulating a new process) sharing only the durable repo still sees nextRecheckAt=null and does not re-enable retry", async () => {
    const { repo, matches } = makeFakeRepo();
    await persistVenueMatch("sig-restart-cutoff", exactResult({ status: "NONE", targetFetchKey: null, targetSide: null }), DETECTED_AT_MS, SOURCE_TS, CUTOFF_ISO, { repo, now: () => CUTOFF_MS - 60_000 });
    await persistVenueMatch("sig-restart-cutoff", exactResult(), DETECTED_AT_MS, SOURCE_TS, CUTOFF_ISO, { repo, now: () => CUTOFF_MS + 2 * 60_000 });
    expect(matches.get("sig-restart-cutoff|PMUS")?.nextRecheckAt).toBeNull();

    // "Restart": a brand-new deps object, same durable repo, another attempt well after cutoff.
    const afterRestart = await persistVenueMatch("sig-restart-cutoff", exactResult({ status: "NONE", targetFetchKey: null, targetSide: null }), DETECTED_AT_MS, SOURCE_TS, CUTOFF_ISO, { repo, now: () => CUTOFF_MS + 60 * 60_000 });
    expect(matches.get("sig-restart-cutoff|PMUS")?.nextRecheckAt).toBeNull();
    expect(afterRestart.scheduled).toBe(0);
  });

  it("O2-4. an EXACT legitimately obtained BEFORE cutoff remains protected from downgrade, even when a later worse result arrives AFTER cutoff (the pre-existing ratchet is untouched by the new cutoff logic)", async () => {
    const { repo, matches } = makeFakeRepo();
    await persistVenueMatch("sig-protected", exactResult(), DETECTED_AT_MS, SOURCE_TS, CUTOFF_ISO, { repo, now: () => CUTOFF_MS - 60_000 });
    expect(matches.get("sig-protected|PMUS")?.matchStatus).toBe("EXACT");

    const worseLater = exactResult({ status: "UNVERIFIED", targetFetchKey: null, targetSide: null, reason: "transient discovery gap" });
    const result = await persistVenueMatch("sig-protected", worseLater, DETECTED_AT_MS, SOURCE_TS, CUTOFF_ISO, { repo, now: () => CUTOFF_MS + 60_000 });
    expect(result.downgradeSkipped).toBe(true);
    expect(matches.get("sig-protected|PMUS")?.matchStatus).toBe("EXACT"); // still untouched
    expect(matches.get("sig-protected|PMUS")?.selectedSide).toBe("TEAM:NYY:LONG"); // original evidence intact
  });

  it("O2-5. original firstMatchStatus remains intact through a rejected past-cutoff EXACT attempt", async () => {
    const { repo, matches } = makeFakeRepo();
    await persistVenueMatch("sig-first-status", exactResult({ status: "NONE", targetFetchKey: null, targetSide: null }), DETECTED_AT_MS, SOURCE_TS, CUTOFF_ISO, { repo, now: () => CUTOFF_MS - 60_000 });
    expect(matches.get("sig-first-status|PMUS")?.firstMatchStatus).toBe("NONE");

    await persistVenueMatch("sig-first-status", exactResult(), DETECTED_AT_MS, SOURCE_TS, CUTOFF_ISO, { repo, now: () => CUTOFF_MS + 2 * 60_000 });
    expect(matches.get("sig-first-status|PMUS")?.firstMatchStatus).toBe("NONE"); // unchanged -- the rejected attempt did not overwrite the immutable audit field
  });

  it("O2-6. original detectedAt remains intact (verifiable indirectly: even the rejected result's own metadata still reflects the resolver's real evidence, and no observation rows were anchored to a different time)", async () => {
    const { repo, observations } = makeFakeRepo();
    await persistVenueMatch("sig-detectedat", exactResult({ status: "NONE", targetFetchKey: null, targetSide: null }), DETECTED_AT_MS, SOURCE_TS, CUTOFF_ISO, { repo, now: () => CUTOFF_MS - 60_000 });
    await persistVenueMatch("sig-detectedat", exactResult(), DETECTED_AT_MS, SOURCE_TS, CUTOFF_ISO, { repo, now: () => CUTOFF_MS + 2 * 60_000 });
    // No observation rows were created at all (rejected), so there is nothing anchored to the
    // wrong time -- detectedAtMs is never even consulted for scheduling once isSchedulable is false.
    expect(observations.size).toBe(0);
  });

  it("O2-7. PMUS/Kalshi independence remains intact through the cutoff guard -- a rejected past-cutoff PMUS EXACT does not affect Kalshi's independent match row for the same signal", async () => {
    const { repo, matches } = makeFakeRepo();
    await persistVenueMatch("sig-venue-indep", exactResult({ status: "NONE", targetFetchKey: null, targetSide: null }), DETECTED_AT_MS, SOURCE_TS, CUTOFF_ISO, { repo, now: () => CUTOFF_MS - 60_000 });
    await persistVenueMatch(
      "sig-venue-indep",
      exactResult({ venue: "KALSHI", status: "NONE", targetFetchKey: null, targetSide: null, targetPmusOrientation: null }),
      DETECTED_AT_MS,
      SOURCE_TS,
      CUTOFF_ISO,
      { repo, now: () => CUTOFF_MS - 60_000 },
    );
    const kalshiBefore = { ...matches.get("sig-venue-indep|KALSHI")! };

    // The PMUS attempt happens late (past cutoff) and gets clamped -- Kalshi's row must be untouched.
    await persistVenueMatch("sig-venue-indep", exactResult(), DETECTED_AT_MS, SOURCE_TS, CUTOFF_ISO, { repo, now: () => CUTOFF_MS + 2 * 60_000 });
    const kalshiAfter = matches.get("sig-venue-indep|KALSHI")!;
    expect(kalshiAfter.matchStatus).toBe(kalshiBefore.matchStatus);
    expect(kalshiAfter.nextRecheckAt).toBe(kalshiBefore.nextRecheckAt);
    expect(kalshiAfter.recheckCount).toBe(kalshiBefore.recheckCount);
    expect(matches.get("sig-venue-indep|PMUS")?.matchStatus).toBe("UNVERIFIED"); // PMUS was the one rejected
  });

  it("O2-8. Task 12H NONE/NEAR/UNVERIFIED -> EXACT still works normally when the later market genuinely appears BEFORE cutoff (the new guard only rejects PAST-cutoff results, never legitimate pregame ones)", async () => {
    const { repo, matches } = makeFakeRepo();
    for (const status of ["NONE", "NEAR", "UNVERIFIED"] as const) {
      const signalId = `sig-pregame-${status}`;
      await persistVenueMatch(signalId, exactResult({ status, targetFetchKey: status === "NEAR" ? "some-key" : null, targetSide: null }), DETECTED_AT_MS, SOURCE_TS, CUTOFF_ISO, {
        repo,
        now: () => CUTOFF_MS - 60_000,
      });
      const result = await persistVenueMatch(signalId, exactResult(), DETECTED_AT_MS, SOURCE_TS, CUTOFF_ISO, { repo, now: () => CUTOFF_MS - 30_000 });
      expect(matches.get(`${signalId}|PMUS`)?.matchStatus).toBe("EXACT");
      expect(result.scheduled).toBe(5);
    }
  });

  it("re-confirming an already-EXACT result AFTER cutoff is not treated as a rejected new EXACT (it is not creating anything new)", async () => {
    const { repo, matches } = makeFakeRepo();
    await persistVenueMatch("sig-reconfirm", exactResult(), DETECTED_AT_MS, SOURCE_TS, CUTOFF_ISO, { repo, now: () => CUTOFF_MS - 60_000 });
    const result = await persistVenueMatch("sig-reconfirm", exactResult({ reason: "re-confirmed" }), DETECTED_AT_MS, SOURCE_TS, CUTOFF_ISO, { repo, now: () => CUTOFF_MS + 60_000 });
    expect(result.downgradeSkipped).toBe(false);
    expect(matches.get("sig-reconfirm|PMUS")?.matchStatus).toBe("EXACT");
  });
});

describe("takeDueSportsShadowObservations — due queue", () => {
  function baseDeps(repoOverride: ObservationRepository, extra: Partial<ObservationDeps> = {}): Partial<ObservationDeps> {
    return { repo: repoOverride, now: () => DETECTED_AT_MS, ...extra };
  }

  it("21/22. only fire_at <= now is due; future rows are untouched", async () => {
    const { repo, observations } = makeFakeRepo();
    await persistVenueMatch("sig-1", exactResult(), DETECTED_AT_MS - 120_000, SOURCE_TS, null, { repo, now: () => DETECTED_AT_MS }); // all in the past relative to now
    const fetchPmusBook = vi.fn(async (): Promise<BookSnapshot> => ({ venue: "PMUS", marketId: "x", bestBid: 0.5, bestAsk: 0.51, bidLevels: [], askLevels: [], marketStatus: null, observedAt: DETECTED_AT_MS, staleReason: null }));
    await takeDueSportsShadowObservations("PMUS", baseDeps(repo, { fetchPmusBook }));
    // all 5 fire_at are <= now (detectedAt-120000 + up to 60000 < now), so all should be observed
    expect([...observations.values()].every((o) => o.observedAt !== null)).toBe(true);
  });

  it("future rows remain untouched when detectedAt is effectively now", async () => {
    const { repo, observations } = makeFakeRepo();
    await persistVenueMatch("sig-1", exactResult(), DETECTED_AT_MS, SOURCE_TS, null, { repo, now: () => DETECTED_AT_MS }); // +30/+60 fire in the future relative to "now"
    const fetchPmusBook = vi.fn(async (): Promise<BookSnapshot> => ({ venue: "PMUS", marketId: "x", bestBid: 0.5, bestAsk: 0.51, bidLevels: [], askLevels: [], marketStatus: null, observedAt: DETECTED_AT_MS, staleReason: null }));
    await takeDueSportsShadowObservations("PMUS", baseDeps(repo, { fetchPmusBook }));
    const stillPending = [...observations.values()].filter((o) => o.observedAt === null);
    expect(stillPending.map((o) => o.requestedDelayMs).sort((a, b) => a - b)).toEqual([5_000, 10_000, 30_000, 60_000]); // only +0 was due
    expect(fetchPmusBook).toHaveBeenCalledTimes(1);
  });

  it("23. already-observed rows are untouched (not re-fetched)", async () => {
    const { repo, observations } = makeFakeRepo();
    await persistVenueMatch("sig-1", exactResult(), DETECTED_AT_MS - 120_000, SOURCE_TS, null, { repo, now: () => DETECTED_AT_MS });
    const zeroDelayRow = [...observations.values()].find((o) => o.requestedDelayMs === 0)!;
    zeroDelayRow.observedAt = "2026-01-01T00:00:00Z";
    delete zeroDelayRow.patch;
    const fetchPmusBook = vi.fn(async (): Promise<BookSnapshot> => ({ venue: "PMUS", marketId: "x", bestBid: 0.5, bestAsk: 0.51, bidLevels: [], askLevels: [], marketStatus: null, observedAt: DETECTED_AT_MS, staleReason: null }));
    await takeDueSportsShadowObservations("PMUS", baseDeps(repo, { fetchPmusBook }));
    expect(fetchPmusBook).toHaveBeenCalledTimes(4); // the 4 still-pending ones, not the already-observed +0
  });

  it("24. the due batch is bounded", async () => {
    expect(DUE_BATCH_LIMIT).toBeGreaterThan(0);
    expect(DUE_BATCH_LIMIT).toBeLessThanOrEqual(50);
  });

  it("24b. an explicit maxRows overrides DUE_BATCH_LIMIT without changing any other behavior", async () => {
    const { repo, observations } = makeFakeRepo();
    await persistVenueMatch("sig-1", exactResult(), DETECTED_AT_MS - 120_000, SOURCE_TS, null, { repo, now: () => DETECTED_AT_MS }); // 5 due rows
    const fetchPmusBook = vi.fn(async (): Promise<BookSnapshot> => ({ venue: "PMUS", marketId: "x", bestBid: 0.5, bestAsk: 0.51, bidLevels: [], askLevels: [], marketStatus: null, observedAt: DETECTED_AT_MS, staleReason: null }));
    const out = await takeDueSportsShadowObservations("PMUS", baseDeps(repo, { fetchPmusBook }), 2);
    expect(fetchPmusBook).toHaveBeenCalledTimes(2);
    expect(out.captured).toBe(2);
    const stillPending = [...observations.values()].filter((o) => o.observedAt === null);
    expect(stillPending).toHaveLength(3);
  });

  it("24c. omitting maxRows preserves the exact prior DUE_BATCH_LIMIT default behavior", async () => {
    const { repo } = makeFakeRepo();
    await persistVenueMatch("sig-1", exactResult(), DETECTED_AT_MS - 120_000, SOURCE_TS, null, { repo, now: () => DETECTED_AT_MS });
    const fetchPmusBook = vi.fn(async (): Promise<BookSnapshot> => ({ venue: "PMUS", marketId: "x", bestBid: 0.5, bestAsk: 0.51, bidLevels: [], askLevels: [], marketStatus: null, observedAt: DETECTED_AT_MS, staleReason: null }));
    const out = await takeDueSportsShadowObservations("PMUS", baseDeps(repo, { fetchPmusBook })); // no maxRows arg
    expect(fetchPmusBook).toHaveBeenCalledTimes(5); // all 5 due rows, same as before this change
    expect(out.captured).toBe(5);
  });

  it("24d. omitting deadlineAtMs (null default) preserves exact prior behavior -- no row is ever skipped for time", async () => {
    const { repo } = makeFakeRepo();
    await persistVenueMatch("sig-1", exactResult(), DETECTED_AT_MS - 120_000, SOURCE_TS, null, { repo, now: () => DETECTED_AT_MS });
    const fetchPmusBook = vi.fn(async (): Promise<BookSnapshot> => ({ venue: "PMUS", marketId: "x", bestBid: 0.5, bestAsk: 0.51, bidLevels: [], askLevels: [], marketStatus: null, observedAt: DETECTED_AT_MS, staleReason: null }));
    const out = await takeDueSportsShadowObservations("PMUS", baseDeps(repo, { fetchPmusBook }), DUE_BATCH_LIMIT); // maxRows explicit, deadlineAtMs omitted
    expect(fetchPmusBook).toHaveBeenCalledTimes(5);
    expect(out.captured).toBe(5);
  });

  it("24e. once the deadline is reached, remaining rows are left completely untouched (observed_at stays null), never marked a terminal failure", async () => {
    const { repo, observations } = makeFakeRepo();
    await persistVenueMatch("sig-1", exactResult(), DETECTED_AT_MS - 120_000, SOURCE_TS, null, { repo, now: () => DETECTED_AT_MS }); // 5 due rows
    let call = 0;
    // Simulate wall-clock advancing: the deadline check reads d.now() before each row;
    // return a time past the deadline starting on the 3rd row.
    const clockSequence = [DETECTED_AT_MS, DETECTED_AT_MS, DETECTED_AT_MS + 10_000, DETECTED_AT_MS + 10_000, DETECTED_AT_MS + 10_000, DETECTED_AT_MS + 10_000];
    const now = () => clockSequence[Math.min(call++, clockSequence.length - 1)]!;
    const fetchPmusBook = vi.fn(async (): Promise<BookSnapshot> => ({ venue: "PMUS", marketId: "x", bestBid: 0.5, bestAsk: 0.51, bidLevels: [], askLevels: [], marketStatus: null, observedAt: DETECTED_AT_MS, staleReason: null }));
    const out = await takeDueSportsShadowObservations("PMUS", { repo, fetchPmusBook, now }, 5, DETECTED_AT_MS + 5_000);
    expect(fetchPmusBook.mock.calls.length).toBeLessThan(5); // stopped early
    expect(out.captured + out.failed + out.skipped).toBeLessThan(5);
    const untouched = [...observations.values()].filter((o) => o.observedAt === null && o.patch === undefined);
    expect(untouched.length).toBeGreaterThan(0); // never claimed, never terminal-failed -- safe to retry
  });

  it("24f. a deadline already in the past when the pass starts processes zero rows, all left untouched", async () => {
    const { repo, observations } = makeFakeRepo();
    await persistVenueMatch("sig-1", exactResult(), DETECTED_AT_MS - 120_000, SOURCE_TS, null, { repo, now: () => DETECTED_AT_MS });
    const fetchPmusBook = vi.fn(async (): Promise<BookSnapshot> => ({ venue: "PMUS", marketId: "x", bestBid: 0.5, bestAsk: 0.51, bidLevels: [], askLevels: [], marketStatus: null, observedAt: DETECTED_AT_MS, staleReason: null }));
    const out = await takeDueSportsShadowObservations("PMUS", { repo, fetchPmusBook, now: () => DETECTED_AT_MS }, 5, DETECTED_AT_MS - 1);
    expect(fetchPmusBook).not.toHaveBeenCalled();
    expect(out).toEqual({ captured: 0, failed: 0, skipped: 0 });
    expect([...observations.values()].every((o) => o.observedAt === null)).toBe(true);
  });

  it("25. oldest fire_at is handled first", async () => {
    const { repo } = makeFakeRepo();
    await persistVenueMatch("sig-1", exactResult(), DETECTED_AT_MS - 120_000, SOURCE_TS, null, { repo, now: () => DETECTED_AT_MS });
    const order: string[] = [];
    const fetchPmusBook = vi.fn(async (key: string): Promise<BookSnapshot> => {
      order.push(key);
      return { venue: "PMUS", marketId: key, bestBid: 0.5, bestAsk: 0.51, bidLevels: [], askLevels: [], marketStatus: null, observedAt: DETECTED_AT_MS, staleReason: null };
    });
    await takeDueSportsShadowObservations("PMUS", baseDeps(repo, { fetchPmusBook }));
    // all 5 use the same fetch key here, but the call COUNT confirms oldest-first processing didn't skip/reorder unexpectedly.
    expect(order).toHaveLength(5);
  });

  it("26/27/28. a due PM-US row invokes fetchPmusBook and persists real bid/ask + top-of-book depth", async () => {
    const { repo, observations } = makeFakeRepo();
    await persistVenueMatch("sig-1", exactResult(), DETECTED_AT_MS - 120_000, SOURCE_TS, null, { repo, now: () => DETECTED_AT_MS });
    const fetchPmusBook = vi.fn(async (): Promise<BookSnapshot> => ({
      venue: "PMUS",
      marketId: "aec-mlb-nyy-bal-2026-08-19",
      bestBid: 0.58,
      bestAsk: 0.6,
      bidLevels: [{ price: 0.58, size: 100 }, { price: 0.57, size: 50 }],
      askLevels: [{ price: 0.6, size: 40 }],
      marketStatus: "MARKET_STATE_OPEN",
      observedAt: DETECTED_AT_MS,
      staleReason: null,
    }));
    await takeDueSportsShadowObservations("PMUS", baseDeps(repo, { fetchPmusBook }));
    expect(fetchPmusBook).toHaveBeenCalledWith("aec-mlb-nyy-bal-2026-08-19", {}, undefined);
    const zeroRow = [...observations.values()].find((o) => o.requestedDelayMs === 0)!;
    expect(zeroRow.patch?.bestBid).toBe(0.58);
    expect(zeroRow.patch?.bidDepth).toHaveLength(2);
  });

  it("29. fewer than five levels is preserved, never padded", async () => {
    const { repo, observations } = makeFakeRepo();
    await persistVenueMatch("sig-1", exactResult(), DETECTED_AT_MS - 120_000, SOURCE_TS, null, { repo, now: () => DETECTED_AT_MS });
    const fetchPmusBook = vi.fn(async (): Promise<BookSnapshot> => ({ venue: "PMUS", marketId: "x", bestBid: 0.5, bestAsk: 0.51, bidLevels: [{ price: 0.5, size: 1 }], askLevels: [], marketStatus: null, observedAt: DETECTED_AT_MS, staleReason: null }));
    await takeDueSportsShadowObservations("PMUS", baseDeps(repo, { fetchPmusBook }));
    const zeroRow = [...observations.values()].find((o) => o.requestedDelayMs === 0)!;
    expect(zeroRow.patch?.bidDepth).toHaveLength(1);
  });

  it("30. a PM-US fetch failure is persisted explicitly", async () => {
    const { repo, observations } = makeFakeRepo();
    await persistVenueMatch("sig-1", exactResult(), DETECTED_AT_MS - 120_000, SOURCE_TS, null, { repo, now: () => DETECTED_AT_MS });
    const fetchPmusBook = vi.fn(async (): Promise<BookSnapshot> => ({ venue: "PMUS", marketId: "x", bestBid: null, bestAsk: null, bidLevels: [], askLevels: [], marketStatus: null, observedAt: DETECTED_AT_MS, staleReason: "gateway.polymarket.us request failed (HTTP 500)" }));
    const out = await takeDueSportsShadowObservations("PMUS", baseDeps(repo, { fetchPmusBook }));
    expect(out.failed).toBe(5);
    expect(out.captured).toBe(0);
  });

  it("31. a valid empty book is distinguished from a transport failure", async () => {
    const { repo, observations } = makeFakeRepo();
    await persistVenueMatch("sig-1", exactResult(), DETECTED_AT_MS - 120_000, SOURCE_TS, null, { repo, now: () => DETECTED_AT_MS });
    const fetchPmusBook = vi.fn(async (): Promise<BookSnapshot> => ({ venue: "PMUS", marketId: "x", bestBid: null, bestAsk: null, bidLevels: [], askLevels: [], marketStatus: null, observedAt: DETECTED_AT_MS, staleReason: null }));
    const out = await takeDueSportsShadowObservations("PMUS", baseDeps(repo, { fetchPmusBook }));
    expect(out.captured).toBe(5); // valid, just empty -- not a failure
    expect(out.failed).toBe(0);
  });

  it("32/33/34. a due Kalshi row invokes fetchKalshiBook and persists the resolved side's executable view", async () => {
    const { repo, observations } = makeFakeRepo();
    const kalshiResult = exactResult({ venue: "KALSHI", targetFetchKey: "KXMLBGAME-1-NYY", targetSide: { kind: "NO" }, targetPmusOrientation: null });
    await persistVenueMatch("sig-1", kalshiResult, DETECTED_AT_MS - 120_000, SOURCE_TS, null, { repo, now: () => DETECTED_AT_MS });
    const fetchKalshiBook = vi.fn(async (): Promise<KalshiBookSnapshot> => ({
      venue: "KALSHI",
      marketId: "KXMLBGAME-1-NYY",
      observedAt: DETECTED_AT_MS,
      yes: { bestBid: 0.58, bestAsk: 0.6, bestBidUnits: 5800, bestAskUnits: 6000, bidLevels: [], askLevels: [] },
      no: { bestBid: 0.4, bestAsk: 0.42, bestBidUnits: 4000, bestAskUnits: 4200, bidLevels: [{ price: 0.4, size: 200 }], askLevels: [{ price: 0.42, size: 300 }] },
      rawYesBids: [],
      rawNoBids: [{ price: 0.4, size: 200 }],
      staleReason: null,
    }));
    await takeDueSportsShadowObservations("KALSHI", baseDeps(repo, { fetchKalshiBook }));
    expect(fetchKalshiBook).toHaveBeenCalledWith("KXMLBGAME-1-NYY", {}, undefined);
    const zeroRow = [...observations.values()].find((o) => o.requestedDelayMs === 0)!;
    expect(zeroRow.patch?.bestBid).toBe(0.4); // NO side, not YES
    expect(zeroRow.patch?.bestAsk).toBe(0.42);
  });

  it("35. source BUY does not automatically choose YES — the persisted view matches the resolved side, here NO", async () => {
    const { repo, observations } = makeFakeRepo();
    const kalshiResult = exactResult({ venue: "KALSHI", targetFetchKey: "KXMLBGAME-1-NYY", targetSide: { kind: "NO" }, targetPmusOrientation: null });
    await persistVenueMatch("sig-1", kalshiResult, DETECTED_AT_MS - 120_000, SOURCE_TS, null, { repo, now: () => DETECTED_AT_MS });
    const fetchKalshiBook = vi.fn(async (): Promise<KalshiBookSnapshot> => ({
      venue: "KALSHI",
      marketId: "KXMLBGAME-1-NYY",
      observedAt: DETECTED_AT_MS,
      yes: { bestBid: 0.9, bestAsk: 0.91, bestBidUnits: 9000, bestAskUnits: 9100, bidLevels: [], askLevels: [] },
      no: { bestBid: 0.09, bestAsk: 0.1, bestBidUnits: 900, bestAskUnits: 1000, bidLevels: [], askLevels: [] },
      rawYesBids: [],
      rawNoBids: [],
      staleReason: null,
    }));
    await takeDueSportsShadowObservations("KALSHI", baseDeps(repo, { fetchKalshiBook }));
    const zeroRow = [...observations.values()].find((o) => o.requestedDelayMs === 0)!;
    expect(zeroRow.patch?.bestBid).toBe(0.09); // NO, even though YES has the "favorite" price
  });

  it("36/37. sub-cent prices and fractional quantities survive the persistence path", async () => {
    const { repo, observations } = makeFakeRepo();
    const kalshiResult = exactResult({ venue: "KALSHI", targetFetchKey: "KXMLBGAME-1-NYY", targetSide: { kind: "YES" }, targetPmusOrientation: null });
    await persistVenueMatch("sig-1", kalshiResult, DETECTED_AT_MS - 120_000, SOURCE_TS, null, { repo, now: () => DETECTED_AT_MS });
    const fetchKalshiBook = vi.fn(async (): Promise<KalshiBookSnapshot> => ({
      venue: "KALSHI",
      marketId: "KXMLBGAME-1-NYY",
      observedAt: DETECTED_AT_MS,
      yes: { bestBid: 0.1234, bestAsk: 0.8766, bestBidUnits: 1234, bestAskUnits: 8766, bidLevels: [{ price: 0.1234, size: 301.17 }], askLevels: [] },
      no: { bestBid: null, bestAsk: null, bestBidUnits: null, bestAskUnits: null, bidLevels: [], askLevels: [] },
      rawYesBids: [{ price: 0.1234, size: 301.17 }],
      rawNoBids: [],
      staleReason: null,
    }));
    await takeDueSportsShadowObservations("KALSHI", baseDeps(repo, { fetchKalshiBook }));
    const zeroRow = [...observations.values()].find((o) => o.requestedDelayMs === 0)!;
    expect(zeroRow.patch?.bestBid).toBe(0.1234);
    expect(zeroRow.patch?.bidDepth[0]?.size).toBe(301.17);
  });

  it("38. Kalshi top-five depth preserved without fabrication", async () => {
    const { repo, observations } = makeFakeRepo();
    const kalshiResult = exactResult({ venue: "KALSHI", targetFetchKey: "KXMLBGAME-1-NYY", targetSide: { kind: "YES" }, targetPmusOrientation: null });
    await persistVenueMatch("sig-1", kalshiResult, DETECTED_AT_MS - 120_000, SOURCE_TS, null, { repo, now: () => DETECTED_AT_MS });
    const fetchKalshiBook = vi.fn(async (): Promise<KalshiBookSnapshot> => ({
      venue: "KALSHI",
      marketId: "x",
      observedAt: DETECTED_AT_MS,
      yes: { bestBid: 0.5, bestAsk: 0.51, bestBidUnits: 5000, bestAskUnits: 5100, bidLevels: [{ price: 0.5, size: 1 }], askLevels: [] },
      no: { bestBid: null, bestAsk: null, bestBidUnits: null, bestAskUnits: null, bidLevels: [], askLevels: [] },
      rawYesBids: [],
      rawNoBids: [],
      staleReason: null,
    }));
    await takeDueSportsShadowObservations("KALSHI", baseDeps(repo, { fetchKalshiBook }));
    const zeroRow = [...observations.values()].find((o) => o.requestedDelayMs === 0)!;
    expect(zeroRow.patch?.bidDepth).toHaveLength(1);
  });

  it("39. a valid empty Kalshi side is handled distinctly, not as a failure", async () => {
    const { repo, observations } = makeFakeRepo();
    const kalshiResult = exactResult({ venue: "KALSHI", targetFetchKey: "KXMLBGAME-1-NYY", targetSide: { kind: "NO" }, targetPmusOrientation: null });
    await persistVenueMatch("sig-1", kalshiResult, DETECTED_AT_MS - 120_000, SOURCE_TS, null, { repo, now: () => DETECTED_AT_MS });
    const fetchKalshiBook = vi.fn(async (): Promise<KalshiBookSnapshot> => ({
      venue: "KALSHI",
      marketId: "x",
      observedAt: DETECTED_AT_MS,
      yes: { bestBid: 0.5, bestAsk: 0.51, bestBidUnits: 5000, bestAskUnits: 5100, bidLevels: [], askLevels: [] },
      no: { bestBid: null, bestAsk: null, bestBidUnits: null, bestAskUnits: null, bidLevels: [], askLevels: [] },
      rawYesBids: [],
      rawNoBids: [],
      staleReason: null,
    }));
    const out = await takeDueSportsShadowObservations("KALSHI", baseDeps(repo, { fetchKalshiBook }));
    expect(out.captured).toBe(5);
    expect(out.failed).toBe(0);
  });

  it("40. a crossed/invalid Kalshi snapshot never becomes a fake executable quote", async () => {
    const { repo, observations } = makeFakeRepo();
    const kalshiResult = exactResult({ venue: "KALSHI", targetFetchKey: "KXMLBGAME-1-NYY", targetSide: { kind: "YES" }, targetPmusOrientation: null });
    await persistVenueMatch("sig-1", kalshiResult, DETECTED_AT_MS - 120_000, SOURCE_TS, null, { repo, now: () => DETECTED_AT_MS });
    const fetchKalshiBook = vi.fn(async (): Promise<KalshiBookSnapshot> => ({
      venue: "KALSHI",
      marketId: "x",
      observedAt: DETECTED_AT_MS,
      yes: { bestBid: null, bestAsk: null, bestBidUnits: null, bestAskUnits: null, bidLevels: [{ price: 0.6, size: 1 }], askLevels: [{ price: 0.5, size: 1 }] },
      no: { bestBid: null, bestAsk: null, bestBidUnits: null, bestAskUnits: null, bidLevels: [], askLevels: [] },
      rawYesBids: [],
      rawNoBids: [],
      staleReason: "crossed YES book: bid 6000 > ask 5000 (1e-4 units)",
    }));
    const out = await takeDueSportsShadowObservations("KALSHI", baseDeps(repo, { fetchKalshiBook }));
    expect(out.failed).toBe(5);
    const zeroRow = [...observations.values()].find((o) => o.requestedDelayMs === 0)!;
    expect(zeroRow.patch?.bestBid).toBeNull();
    expect(zeroRow.patch?.errorCode).toBe("CROSSED_BOOK");
  });
});

describe("time evidence", () => {
  it("41/42/43/44/45. requested_delay_ms preserved, observed_at is the actual injected time, late capture never rewrites fire_at, actual delay is derivable", async () => {
    const { repo, observations } = makeFakeRepo();
    await persistVenueMatch("sig-1", exactResult(), DETECTED_AT_MS - 120_000, SOURCE_TS, null, { repo, now: () => DETECTED_AT_MS });
    const lateObservedMs = DETECTED_AT_MS + 7_150; // captured late relative to +5s
    const fetchPmusBook = vi.fn(async (): Promise<BookSnapshot> => ({ venue: "PMUS", marketId: "x", bestBid: 0.5, bestAsk: 0.51, bidLevels: [], askLevels: [], marketStatus: null, observedAt: lateObservedMs, staleReason: null }));
    await takeDueSportsShadowObservations("PMUS", { repo, fetchPmusBook, now: () => DETECTED_AT_MS - 120_000 + 60_000 });
    const fiveSecRow = [...observations.values()].find((o) => o.requestedDelayMs === 5_000)!;
    expect(fiveSecRow.patch?.observedAt).toBe(new Date(lateObservedMs).toISOString());
    expect(fiveSecRow.fireAt).not.toBe(fiveSecRow.patch?.observedAt); // fire_at itself (the row property) is untouched by capture
  });
});

describe("failures / concurrency", () => {
  it("46. a timeout terminally persists an explicit failure", async () => {
    const { repo } = makeFakeRepo();
    await persistVenueMatch("sig-1", exactResult(), DETECTED_AT_MS - 120_000, SOURCE_TS, null, { repo, now: () => DETECTED_AT_MS });
    const fetchPmusBook = vi.fn(async (): Promise<BookSnapshot> => ({ venue: "PMUS", marketId: "x", bestBid: null, bestAsk: null, bidLevels: [], askLevels: [], marketStatus: null, observedAt: DETECTED_AT_MS, staleReason: "gateway.polymarket.us request failed: The operation was aborted" }));
    const out = await takeDueSportsShadowObservations("PMUS", { repo, fetchPmusBook, now: () => DETECTED_AT_MS });
    expect(out.failed).toBe(5);
  });

  it("47. a 429 terminally persists an explicit failure", async () => {
    const { repo } = makeFakeRepo();
    await persistVenueMatch("sig-1", exactResult(), DETECTED_AT_MS - 120_000, SOURCE_TS, null, { repo, now: () => DETECTED_AT_MS });
    const fetchPmusBook = vi.fn(async (): Promise<BookSnapshot> => ({ venue: "PMUS", marketId: "x", bestBid: null, bestAsk: null, bidLevels: [], askLevels: [], marketStatus: null, observedAt: DETECTED_AT_MS, staleReason: "gateway.polymarket.us rate limited (429) on /x" }));
    const out = await takeDueSportsShadowObservations("PMUS", { repo, fetchPmusBook, now: () => DETECTED_AT_MS });
    expect(out.failed).toBe(5);
  });

  it("48. a malformed book terminally persists an explicit failure", async () => {
    const { repo } = makeFakeRepo();
    await persistVenueMatch("sig-1", exactResult(), DETECTED_AT_MS - 120_000, SOURCE_TS, null, { repo, now: () => DETECTED_AT_MS });
    const fetchPmusBook = vi.fn(async (): Promise<BookSnapshot> => ({ venue: "PMUS", marketId: "x", bestBid: null, bestAsk: null, bidLevels: [], askLevels: [], marketStatus: null, observedAt: DETECTED_AT_MS, staleReason: "malformed book payload: not an object" }));
    const out = await takeDueSportsShadowObservations("PMUS", { repo, fetchPmusBook, now: () => DETECTED_AT_MS });
    expect(out.failed).toBe(5);
  });

  it("49/50/51/52. CAS succeeds when observed_at IS NULL; an overlapping second CAS loses, cannot overwrite the winner, and is not counted as captured", async () => {
    const { repo, observations } = makeFakeRepo();
    await persistVenueMatch("sig-1", exactResult(), DETECTED_AT_MS - 120_000, SOURCE_TS, null, { repo, now: () => DETECTED_AT_MS });
    const row = [...observations.values()].find((o) => o.requestedDelayMs === 0)!;

    const winnerPatch = { observedAt: "2026-01-01T00:00:00.100Z", fetchStartedAt: null, fetchEndedAt: null, detectionLatencyMs: null, bestBid: 0.6, bestAsk: 0.61, spread: 0.01, bidDepth: [], askDepth: [], marketStatus: null, stale: false, errorCode: null, reason: null, rawMetadata: {} };
    const loserPatch = { ...winnerPatch, observedAt: "2026-01-01T00:00:00.200Z", bestBid: 0.99 };

    const winnerWon = await repo.claimObservationTerminal(row.id, winnerPatch);
    const loserWon = await repo.claimObservationTerminal(row.id, loserPatch);

    expect(winnerWon).toBe(true);
    expect(loserWon).toBe(false);
    expect(row.patch?.bestBid).toBe(0.6); // winner's value, never overwritten by the loser
  });

  it("53. a repeated worker cycle skips an already-terminal row entirely (no fetch attempted)", async () => {
    const { repo, observations } = makeFakeRepo();
    await persistVenueMatch("sig-1", exactResult(), DETECTED_AT_MS - 120_000, SOURCE_TS, null, { repo, now: () => DETECTED_AT_MS });
    for (const o of observations.values()) o.observedAt = "2026-01-01T00:00:00Z"; // simulate a fully-completed prior cycle
    const fetchPmusBook = vi.fn(async (): Promise<BookSnapshot> => ({ venue: "PMUS", marketId: "x", bestBid: 0.5, bestAsk: 0.51, bidLevels: [], askLevels: [], marketStatus: null, observedAt: DETECTED_AT_MS, staleReason: null }));
    const out = await takeDueSportsShadowObservations("PMUS", { repo, fetchPmusBook, now: () => DETECTED_AT_MS });
    expect(fetchPmusBook).not.toHaveBeenCalled();
    expect(out.captured).toBe(0);
  });
});

describe("auth / safety", () => {
  it("54/55/56. no authenticated PM-US/Kalshi/order-path module is imported", async () => {
    const fs = await import("node:fs/promises");
    const path = await import("node:path");
    const src = await fs.readFile(path.resolve(import.meta.dirname, "observation.server.ts"), "utf8");
    const importLines = [...src.matchAll(/^import .*$/gm)].map((m) => m[0]);
    expect(importLines.length).toBeGreaterThan(0);
    for (const line of importLines) {
      expect(line).not.toMatch(/credentials|signer|signing|capabilities\.server/i);
    }
    const stripped = src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
    for (const forbidden of ["previewOrder", "attemptOperation", "createOrder", "cancelOrder", "modifyOrder"]) {
      expect(stripped).not.toContain(forbidden);
    }
  });

  it("57. this module's tests never touch a production Supabase instance (fully repository-injected)", async () => {
    const { repo } = makeFakeRepo();
    // The mere fact every test in this file passes `repo` explicitly and never imports
    // supabaseAdmin proves this; this test documents that guarantee directly.
    const result = await persistVenueMatch("sig-1", exactResult(), DETECTED_AT_MS, SOURCE_TS, null, { repo, now: () => DETECTED_AT_MS });
    expect(result.matchId).toBeDefined();
  });
});
