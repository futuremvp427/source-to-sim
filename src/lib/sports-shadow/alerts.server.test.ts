import { describe, expect, it } from "vitest";

import { evaluateAlertConditions, raiseAlert, raiseMilestoneAlert, resolveAlert, type AlertRepository, type TelegramDeliveryFn } from "./alerts.server";

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
    sourcePollFailed: false,
    rateLimitStormDetected: false,
    settlementStuckCount: 0,
    sourceCoverageGap: false,
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
    expect(alerts[0]?.kind).toBe("sports_shadow_venue_starved");
  });

  it("raises observation_backlog only once the threshold is exceeded, not at/under it", () => {
    expect(evaluateAlertConditions({ ...baseInput(), observationBacklogCount: 50 })).toHaveLength(0);
    expect(evaluateAlertConditions({ ...baseInput(), observationBacklogCount: 51 })).toHaveLength(1);
    expect(evaluateAlertConditions({ ...baseInput(), observationBacklogCount: 51 })[0]?.kind).toBe("sports_shadow_observation_backlog");
  });

  it("integrity audit failure is CRITICAL severity with the integrity_failed kind", () => {
    const alerts = evaluateAlertConditions({ ...baseInput(), integrityAuditPassed: false });
    expect(alerts[0]?.severity).toBe("CRITICAL");
    expect(alerts[0]?.kind).toBe("sports_shadow_integrity_failed");
  });

  it("scheduler stalled beyond threshold raises CRITICAL, a null age (never run yet) does not", () => {
    expect(evaluateAlertConditions({ ...baseInput(), schedulerLastRunAgeMs: 400_000 })).toHaveLength(1);
    expect(evaluateAlertConditions({ ...baseInput(), schedulerLastRunAgeMs: null })).toHaveLength(0);
  });

  it("source poll failure, rate-limit storm, and stuck settlements each raise their own kind", () => {
    expect(evaluateAlertConditions({ ...baseInput(), sourcePollFailed: true })[0]?.kind).toBe("sports_shadow_source_unhealthy");
    expect(evaluateAlertConditions({ ...baseInput(), rateLimitStormDetected: true })[0]?.kind).toBe("sports_shadow_rate_limit_storm");
    expect(evaluateAlertConditions({ ...baseInput(), settlementStuckCount: 3 })[0]?.kind).toBe("sports_shadow_settlement_stuck");
    expect(evaluateAlertConditions({ ...baseInput(), settlementStuckCount: 0 })).toHaveLength(0);
  });

  it("raises a source coverage gap when the lane ran but attempted zero configured wallets", () => {
    const alerts = evaluateAlertConditions({ ...baseInput(), sourceCoverageGap: true });
    expect(alerts).toHaveLength(1);
    expect(alerts[0]?.kind).toBe("sports_shadow_source_coverage_gap");
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
        if (await this.hasUnresolved(key)) return { raised: false, id: null };
        raiseCalls.push(key);
        return { raised: true, id: "row-1" };
      },
      async resolve() {},
    };
    await raiseAlert("already-active", "WARNING", "test", "sports_shadow_venue_starved", repo, async () => {});
    expect(raiseCalls).toHaveLength(0);
    await raiseAlert("brand-new", "WARNING", "test", "sports_shadow_venue_starved", repo, async () => {});
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
    await expect(raiseAlert("k", "WARNING", "m", "sports_shadow_venue_starved", repo, async () => {})).resolves.toBeUndefined();
    await expect(resolveAlert("k", repo)).resolves.toBeUndefined();
  });
});

describe("Telegram integration: raiseAlert delivers only on a fresh (raised:true) activation", () => {
  function repoAlwaysFresh(id = "row-1"): AlertRepository {
    return {
      async hasUnresolved() {
        return false;
      },
      async raise() {
        return { raised: true, id };
      },
      async resolve() {},
    };
  }

  function repoAlreadyActive(): AlertRepository {
    return {
      async hasUnresolved() {
        return true;
      },
      async raise() {
        return { raised: false, id: null };
      },
      async resolve() {},
    };
  }

  it("delivers to Telegram exactly once when the underlying sports_shadow_alerts raise is a fresh activation", async () => {
    const delivered: { level: string; kind: string; message: string; dedupKey: string }[] = [];
    const deliver: TelegramDeliveryFn = async (level, kind, message, dedupKey) => {
      delivered.push({ level, kind, message, dedupKey });
    };
    await raiseAlert("venue_discovery_failed:PMUS", "WARNING", "PM-US discovery has failed", "sports_shadow_venue_starved", repoAlwaysFresh("row-42"), deliver);
    expect(delivered).toHaveLength(1);
    expect(delivered[0]?.kind).toBe("sports_shadow_venue_starved");
    expect(delivered[0]?.level).toBe("warn");
    expect(delivered[0]?.dedupKey).toBe("sports_shadow_alert:row-42");
  });

  it("does NOT call Telegram delivery while the same condition is already active (no repeat spam)", async () => {
    const delivered: unknown[] = [];
    const deliver: TelegramDeliveryFn = async (...args) => {
      delivered.push(args);
    };
    await raiseAlert("venue_discovery_failed:PMUS", "WARNING", "still down", "sports_shadow_venue_starved", repoAlreadyActive(), deliver);
    expect(delivered).toHaveLength(0);
  });

  it("CRITICAL severity maps to Telegram level 'error', WARNING to 'warn'", async () => {
    const levels: string[] = [];
    const deliver: TelegramDeliveryFn = async (level) => {
      levels.push(level);
    };
    await raiseAlert("k1", "CRITICAL", "m", "sports_shadow_integrity_failed", repoAlwaysFresh(), deliver);
    await raiseAlert("k2", "WARNING", "m", "sports_shadow_venue_starved", repoAlwaysFresh(), deliver);
    expect(levels).toEqual(["error", "warn"]);
  });

  it("a Telegram delivery failure is swallowed -- best-effort, never breaks the caller or the sports_shadow_alerts write", async () => {
    const deliver: TelegramDeliveryFn = async () => {
      throw new Error("telegram down");
    };
    await expect(raiseAlert("k", "WARNING", "m", "sports_shadow_venue_starved", repoAlwaysFresh(), deliver)).resolves.toBeUndefined();
  });
});

describe("Telegram integration: raiseMilestoneAlert is permanently deduplicated per epoch", () => {
  it("calls delivery with a dedup key scoped to (epochId, milestone kind), independent of sports_shadow_alerts", async () => {
    const delivered: { kind: string; dedupKey: string }[] = [];
    const deliver: TelegramDeliveryFn = async (_level, kind, _message, dedupKey) => {
      delivered.push({ kind, dedupKey });
    };
    await raiseMilestoneAlert("epoch-7", "sports_shadow_calibration_100", "Calibration reached 100 independent episodes", deliver);
    expect(delivered).toEqual([{ kind: "sports_shadow_calibration_100", dedupKey: "sports_shadow_milestone:epoch-7:sports_shadow_calibration_100" }]);
  });

  it("calling raiseMilestoneAlert repeatedly (e.g. multiple cycle re-evaluations) always uses the SAME dedup key -- exactly-once delivery is enforced by the general alerts table's dedup_key UNIQUE constraint, not by this function tracking state itself", async () => {
    const dedupKeys: string[] = [];
    const deliver: TelegramDeliveryFn = async (_level, _kind, _message, dedupKey) => {
      dedupKeys.push(dedupKey);
    };
    await raiseMilestoneAlert("epoch-7", "sports_shadow_soak_passed", "Soak passed", deliver);
    await raiseMilestoneAlert("epoch-7", "sports_shadow_soak_passed", "Soak passed", deliver);
    expect(dedupKeys).toEqual(["sports_shadow_milestone:epoch-7:sports_shadow_soak_passed", "sports_shadow_milestone:epoch-7:sports_shadow_soak_passed"]);
  });

  it("a delivery failure is swallowed -- best-effort by design", async () => {
    const deliver: TelegramDeliveryFn = async () => {
      throw new Error("telegram down");
    };
    await expect(raiseMilestoneAlert("epoch-1", "sports_shadow_oos_300", "m", deliver)).resolves.toBeUndefined();
  });
});
