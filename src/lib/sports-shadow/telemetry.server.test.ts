import { describe, expect, it } from "vitest";

import { cycleSummaryToTelemetryEvents, recordTelemetry, type TelemetryEvent, type TelemetryRepository } from "./telemetry.server";

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
