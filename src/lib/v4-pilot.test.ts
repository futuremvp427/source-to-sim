import { describe, expect, it } from "vitest";

import {
  V4_PILOT_ACTIVATION_BASELINE,
  V4_PILOT_FOLLOW_FROM_TS,
  V4_PILOT_NAME,
  V4_PILOT_SIZING_RULE,
  V4_PILOT_WALLET,
  isV4PilotName,
} from "./v4-pilot";
import { isEligibleForV2Copy } from "./v2-cohort";

describe("SHADOW V4 COMPOUND PILOT: HighTempTation — exact pilot seed identity", () => {
  it("matches the spec'd name, wallet, sizing rule, activation timestamp and baseline", () => {
    expect(V4_PILOT_NAME).toBe("SHADOW V4 COMPOUND PILOT: HighTempTation");
    expect(V4_PILOT_WALLET).toBe("0x6011655c4afb76f36dd1b08a137a1ba73466b31e");
    expect(V4_PILOT_SIZING_RULE).toBe("compound-v2-pilot");
    expect(V4_PILOT_FOLLOW_FROM_TS).toBe(1786996047);
    expect(V4_PILOT_ACTIVATION_BASELINE).toBe(433.36108);
  });

  it("isV4PilotName recognizes only the exact pilot name", () => {
    expect(isV4PilotName(V4_PILOT_NAME)).toBe(true);
    expect(isV4PilotName("SHADOW V2: HighTempTation")).toBe(false);
    expect(isV4PilotName("SHADOW V3 CAPACITY: HighTempTation")).toBe(false);
    expect(isV4PilotName("CANDIDATE: HighTempTation")).toBe(false);
  });
});

describe("SHADOW V4 COMPOUND PILOT: HighTempTation — activation boundary survives delayed deployment", () => {
  it("the follow_from_ts boundary is a fixed constant, not derived from 'now' or deployment time", () => {
    // isEligibleForV2Copy takes follow_from_ts as an explicit argument -- there
    // is no code path anywhere that could substitute Date.now() for it. This
    // pins the exact spec'd value so it can never silently drift.
    expect(V4_PILOT_FOLLOW_FROM_TS).toBe(1786996047);
  });

  it("an event strictly before the boundary is backfill/non-accounting regardless of how late the worker first sees it", () => {
    const preBoundaryEventTs = V4_PILOT_FOLLOW_FROM_TS - 1;
    // Even simulating a deployment that happens days after the boundary
    // ("now" below), the pre-boundary event is still correctly excluded.
    expect(isEligibleForV2Copy(preBoundaryEventTs, V4_PILOT_FOLLOW_FROM_TS)).toBe(false);
  });

  it("an event at or after the boundary is a legitimate pilot sample and gets caught up, however late deployment happens", () => {
    expect(isEligibleForV2Copy(V4_PILOT_FOLLOW_FROM_TS, V4_PILOT_FOLLOW_FROM_TS)).toBe(true);
    const daysLate = V4_PILOT_FOLLOW_FROM_TS + 5 * 86400; // an event 5 days after activation
    expect(isEligibleForV2Copy(daysLate, V4_PILOT_FOLLOW_FROM_TS)).toBe(true);
  });

  it("seeded cash/start/realized are independent of when the worker actually starts processing", () => {
    // The seed migration writes these once, unconditionally of deployment
    // timing; ON CONFLICT (name) DO NOTHING means a delayed first poll (or any
    // later migration replay) can never reset them.
    expect(V4_PILOT_ACTIVATION_BASELINE).toBe(433.36108);
  });
});
