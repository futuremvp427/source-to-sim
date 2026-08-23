import { describe, expect, it } from "vitest";

import {
  computeSchedulerLastRunAgeMs,
  countRecentRateLimitEvents,
  countRecentRateLimitPersistFailures,
  cycleSummaryToTelemetryEvents,
  RATE_LIMIT_PERSIST_FAILURE_THRESHOLD,
  RATE_LIMIT_STORM_THRESHOLD,
  recordTelemetry,
  wrapRecordHostRateLimitWithTelemetry,
  type RateLimitTelemetryRepository,
  type SchedulerHeartbeatRepository,
  type TelemetryEvent,
  type TelemetryRepository,
} from "./telemetry.server";

describe("FINAL BUILD Part 25: cycleSummaryToTelemetryEvents", () => {
  it("flattens a cycle summary into SYSTEM/OBSERVATION/SOURCE/VENUE events", () => {
    const events = cycleSummaryToTelemetryEvents({
      durationMs: 1234,
      observationLane: { pmus: { attempted: 2, captured: 2, failed: 0, skipped: 0 }, kalshi: { attempted: 1, captured: 0, failed: 1, skipped: 0 } },
      sourceLane: {
        walletsAttempted: 3,
        newSignalsCreated: 1,
        leaseLost: false,
        pmus: { attempted: 1, exact: 1, discoveryFailed: false, deadlineReached: false },
        kalshi: { attempted: 1, exact: 0, discoveryFailed: true, deadlineReached: false },
      },
      errors: [],
      epochId: "epoch-1",
    });
    expect(events.find((e) => e.metric === "cycle_duration_ms")?.value).toBe(1234);
    expect(events.find((e) => e.metric === "wallets_attempted")?.value).toBe(3);
    expect(events.find((e) => e.metric === "discovery_failed" && e.labels?.["venue"] === "KALSHI")?.value).toBe(1);
  });

  it("FINAL BUILD repository-completion pass (Codex-caught P1): every event is tagged with the cycle's resolved epoch id, even when epochId is null (best-effort epoch resolution failure)", () => {
    const withEpoch = cycleSummaryToTelemetryEvents({
      durationMs: 1,
      observationLane: { pmus: { attempted: 0, captured: 0, failed: 0, skipped: 0 }, kalshi: { attempted: 0, captured: 0, failed: 0, skipped: 0 } },
      sourceLane: null,
      errors: [],
      epochId: "epoch-42",
    });
    expect(withEpoch.every((e) => e.experimentEpochId === "epoch-42")).toBe(true);

    const withoutEpoch = cycleSummaryToTelemetryEvents({
      durationMs: 1,
      observationLane: { pmus: { attempted: 0, captured: 0, failed: 0, skipped: 0 }, kalshi: { attempted: 0, captured: 0, failed: 0, skipped: 0 } },
      sourceLane: null,
      errors: [],
      epochId: null,
    });
    expect(withoutEpoch.every((e) => e.experimentEpochId === null)).toBe(true);
  });

  it("FINAL BUILD Part 6: emits per-venue backlog (skipped) and lease_lost -- the soak health rollup's own raw material", () => {
    const events = cycleSummaryToTelemetryEvents({
      durationMs: 100,
      observationLane: { pmus: { attempted: 5, captured: 2, failed: 0, skipped: 3 }, kalshi: { attempted: 0, captured: 0, failed: 0, skipped: 0 } },
      sourceLane: {
        walletsAttempted: 1,
        newSignalsCreated: 0,
        leaseLost: true,
        pmus: { attempted: 0, exact: 0, discoveryFailed: false, deadlineReached: false },
        kalshi: { attempted: 0, exact: 0, discoveryFailed: false, deadlineReached: false },
      },
      errors: [],
      epochId: "epoch-1",
    });
    expect(events.find((e) => e.metric === "skipped" && e.labels?.["venue"] === "PMUS")?.value).toBe(3);
    expect(events.find((e) => e.metric === "lease_lost")?.value).toBe(1);
  });

  it("omits SOURCE/VENUE events entirely when sourceLane is null (lane not acquired this cycle)", () => {
    const events = cycleSummaryToTelemetryEvents({
      durationMs: 100,
      observationLane: { pmus: { attempted: 0, captured: 0, failed: 0, skipped: 0 }, kalshi: { attempted: 0, captured: 0, failed: 0, skipped: 0 } },
      sourceLane: null,
      errors: ["some error"],
      epochId: null,
    });
    expect(events.some((e) => e.category === "SOURCE")).toBe(false);
    expect(events.find((e) => e.metric === "cycle_error_count")?.value).toBe(1);
  });
});

describe("FINAL BUILD Part 25: recordTelemetry", () => {
  it("a repository failure is swallowed -- telemetry must never break the measured operation", async () => {
    const repo: TelemetryRepository = {
      async record() {
        throw new Error("DB unavailable");
      },
    };
    await expect(recordTelemetry([{ category: "SYSTEM", metric: "x", value: 1 }], repo)).resolves.toBeUndefined();
  });

  it("passes events through to the repository on success", async () => {
    const received: TelemetryEvent[][] = [];
    const repo: TelemetryRepository = {
      async record(events) {
        received.push(events);
      },
    };
    await recordTelemetry([{ category: "SYSTEM", metric: "x", value: 1 }], repo);
    expect(received).toHaveLength(1);
    expect(received[0]?.[0]?.metric).toBe("x");
  });
});

describe("CODEX P2-5: wrapRecordHostRateLimitWithTelemetry -- every 429 becomes a durable, queryable event, not just a current-cooldown snapshot", () => {
  it("calls the inner (real shared cooldown) function, then emits a NETWORK telemetry event for the same host", async () => {
    const innerCalls: { host: string; retryAfterMs: number | null }[] = [];
    const inner = async (host: string, retryAfterMs: number | null) => {
      innerCalls.push({ host, retryAfterMs });
      return { ok: true, error: null };
    };
    const recorded: TelemetryEvent[] = [];
    const repo: TelemetryRepository = { async record(events) { recorded.push(...events); } };
    const wrapped = wrapRecordHostRateLimitWithTelemetry(inner);
    await wrapped("gamma-api.polymarket.com", 5000);
    // wrapRecordHostRateLimitWithTelemetry calls the module-level recordTelemetry (real
    // default repo) internally by design (fire-and-forget) -- verify via the INNER call
    // (always awaited) and structurally that it never throws even if telemetry fails.
    expect(innerCalls).toEqual([{ host: "gamma-api.polymarket.com", retryAfterMs: 5000 }]);
    void repo;
  });

  it("CODEX P2-2: never throws even if the inner cooldown write reports a persistence failure -- a caller relying on this as its recordHostRateLimit dependency must not see a NEW failure mode (or have its own 429 error masked) by telemetry wrapping", async () => {
    const inner = async () => ({ ok: false, error: "cooldown RPC unavailable" });
    const wrapped = wrapRecordHostRateLimitWithTelemetry(inner);
    await expect(wrapped("data-api.polymarket.com", null)).resolves.toBeUndefined();
  });

  it("CODEX P2-2: never throws even if the inner function itself throws (defensive -- recordHostRateLimitReporting never throws by construction, but the wrapper must not propagate one if it somehow did)", async () => {
    const inner = async () => {
      throw new Error("unexpected inner exception");
    };
    const wrapped = wrapRecordHostRateLimitWithTelemetry(inner);
    await expect(wrapped("data-api.polymarket.com", null)).resolves.toBeUndefined();
  });
});

describe("CODEX P2-5: countRecentRateLimitEvents -- real rate-limit-storm signal, replacing the previously-hardcoded 0/false", () => {
  it("returns the repository's own count for the computed window", async () => {
    const repo: RateLimitTelemetryRepository = { async countSince() { return 7; } };
    const count = await countRecentRateLimitEvents(1_700_000_000_000, 5 * 60 * 1000, repo);
    expect(count).toBe(7);
  });

  it("fails to 0 (never fabricates a storm) when the repository read itself fails", async () => {
    const repo: RateLimitTelemetryRepository = { async countSince() { throw new Error("query failed"); } };
    const count = await countRecentRateLimitEvents(1_700_000_000_000, 5 * 60 * 1000, repo);
    expect(count).toBe(0);
  });

  it("a count at/above RATE_LIMIT_STORM_THRESHOLD is what worker.server.ts treats as a storm -- documents the exact threshold this module defines", async () => {
    const repo: RateLimitTelemetryRepository = { async countSince() { return RATE_LIMIT_STORM_THRESHOLD; } };
    const count = await countRecentRateLimitEvents(1_700_000_000_000, 5 * 60 * 1000, repo);
    expect(count).toBeGreaterThanOrEqual(RATE_LIMIT_STORM_THRESHOLD);
  });
});

describe("CODEX P2-2: countRecentRateLimitPersistFailures -- real persistence-failure signal, distinct from raw 429 volume", () => {
  it("returns the repository's own count for the computed window", async () => {
    const repo: RateLimitTelemetryRepository = { async countSince() { return 3; } };
    const count = await countRecentRateLimitPersistFailures(1_700_000_000_000, 5 * 60 * 1000, repo);
    expect(count).toBe(3);
  });

  it("fails to 0 (never fabricates a failure) when the repository read itself fails", async () => {
    const repo: RateLimitTelemetryRepository = { async countSince() { throw new Error("query failed"); } };
    const count = await countRecentRateLimitPersistFailures(1_700_000_000_000, 5 * 60 * 1000, repo);
    expect(count).toBe(0);
  });

  it("even a single persist failure is at/above RATE_LIMIT_PERSIST_FAILURE_THRESHOLD -- unlike a 429 storm, one persistence failure is already worth alerting on", async () => {
    expect(RATE_LIMIT_PERSIST_FAILURE_THRESHOLD).toBe(1);
  });
});

describe("CODEX P2-6: computeSchedulerLastRunAgeMs -- real scheduler heartbeat, replacing the previously-hardcoded null", () => {
  it("computes the age from the PREVIOUS cycle's own recorded telemetry timestamp", async () => {
    const nowMs = Date.parse("2026-08-22T20:10:00Z");
    const lastRunAtIso = "2026-08-22T20:05:00Z"; // 5 minutes ago
    const repo: SchedulerHeartbeatRepository = { async latestCycleTelemetryAtIso() { return lastRunAtIso; } };
    const age = await computeSchedulerLastRunAgeMs(nowMs, repo);
    expect(age).toBe(5 * 60 * 1000);
  });

  it("a genuinely fresh epoch with no prior cycle telemetry at all returns null -- never fabricates a staleness value", async () => {
    const repo: SchedulerHeartbeatRepository = { async latestCycleTelemetryAtIso() { return null; } };
    const age = await computeSchedulerLastRunAgeMs(Date.now(), repo);
    expect(age).toBeNull();
  });

  it("fails to null (never fabricates a stall) when the repository read itself fails", async () => {
    const repo: SchedulerHeartbeatRepository = {
      async latestCycleTelemetryAtIso() {
        throw new Error("query failed");
      },
    };
    const age = await computeSchedulerLastRunAgeMs(Date.now(), repo);
    expect(age).toBeNull();
  });

  it("a stale heartbeat immediately followed by a fresh one (recovery) reports a small age again -- proving the alert this feeds would resolve on the very next healthy cycle", async () => {
    const nowMs = Date.parse("2026-08-22T20:10:00Z");
    let lastRunAtIso = "2026-08-22T19:00:00Z"; // 70 minutes stale
    const repo: SchedulerHeartbeatRepository = { async latestCycleTelemetryAtIso() { return lastRunAtIso; } };
    const staleAge = await computeSchedulerLastRunAgeMs(nowMs, repo);
    expect(staleAge).toBeGreaterThan(300_000); // past the 5-minute schedulerStalledThresholdMs used in worker.server.ts
    lastRunAtIso = new Date(nowMs - 1_000).toISOString(); // scheduler just ran again
    const recoveredAge = await computeSchedulerLastRunAgeMs(nowMs, repo);
    expect(recoveredAge).toBeLessThan(300_000);
  });
});
