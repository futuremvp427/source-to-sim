import { describe, expect, it } from "vitest";

import { evaluateAlertConditions, raiseAlert, resolveAlert, type AlertRepository } from "./alerts.server";

function baseInput() {
  return {
    pmusDiscoveryFailed: false,
    kalshiDiscoveryFailed: false,
    pmusLeaseLost: false,
    kalshiLeaseLost: false,
    observationBacklogCount: 0,
    observationBacklogThreshold: 50,
    integrityAuditPassed: true,
    schedulerLastRunAgeMs: 10_000,
    schedulerStalledThresholdMs: 300_000,
  };
}

describe("FINAL BUILD Part 27: evaluateAlertConditions", () => {
  it("no alerts when everything is healthy", () => {
    expect(evaluateAlertConditions(baseInput())).toHaveLength(0);
  });

  it("raises a venue-specific discovery-failed alert, never a generic one", () => {
    const alerts = evaluateAlertConditions({ ...baseInput(), kalshiDiscoveryFailed: true });
    expect(alerts).toHaveLength(1);
    expect(alerts[0]?.alertKey).toBe("venue_discovery_failed:KALSHI");
  });

  it("raises observation_backlog only once the threshold is exceeded, not at/under it", () => {
    expect(evaluateAlertConditions({ ...baseInput(), observationBacklogCount: 50 })).toHaveLength(0);
    expect(evaluateAlertConditions({ ...baseInput(), observationBacklogCount: 51 })).toHaveLength(1);
  });

  it("integrity audit failure is CRITICAL severity", () => {
    const alerts = evaluateAlertConditions({ ...baseInput(), integrityAuditPassed: false });
    expect(alerts[0]?.severity).toBe("CRITICAL");
  });

  it("scheduler stalled beyond threshold raises CRITICAL, a null age (never run yet) does not", () => {
    expect(evaluateAlertConditions({ ...baseInput(), schedulerLastRunAgeMs: 400_000 })).toHaveLength(1);
    expect(evaluateAlertConditions({ ...baseInput(), schedulerLastRunAgeMs: null })).toHaveLength(0);
  });

  it("multiple simultaneous conditions all surface independently", () => {
    const alerts = evaluateAlertConditions({ ...baseInput(), pmusDiscoveryFailed: true, kalshiLeaseLost: true, integrityAuditPassed: false });
    expect(alerts).toHaveLength(3);
  });
});

describe("FINAL BUILD Part 27: raiseAlert / resolveAlert dedup", () => {
  it("raiseAlert is a no-op (does not create a second row) while an unresolved alert under the same key already exists", async () => {
    const raiseCalls: string[] = [];
    const repo: AlertRepository = {
      async hasUnresolved(key) {
        return key === "already-active";
      },
      async raise(key) {
        // Mirrors supabaseAlertRepository.raise's own documented contract: check
        // hasUnresolved before actually raising.
        if (await this.hasUnresolved(key)) return { raised: false };
        raiseCalls.push(key);
        return { raised: true };
      },
      async resolve() {},
    };
    await raiseAlert("already-active", "WARNING", "test", repo);
    expect(raiseCalls).toHaveLength(0);
    await raiseAlert("brand-new", "WARNING", "test", repo);
    expect(raiseCalls).toEqual(["brand-new"]);
  });

  it("a repository failure in raiseAlert/resolveAlert is swallowed -- alerting must never break the caller", async () => {
    const repo: AlertRepository = {
      async hasUnresolved() {
        throw new Error("db down");
      },
      async raise() {
        throw new Error("db down");
      },
      async resolve() {
        throw new Error("db down");
      },
    };
    await expect(raiseAlert("k", "WARNING", "m", repo)).resolves.toBeUndefined();
    await expect(resolveAlert("k", repo)).resolves.toBeUndefined();
  });
});
