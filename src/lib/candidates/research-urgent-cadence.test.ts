import { describe, expect, it } from "vitest";

import {
  RESEARCH_BUDGET_MS,
  URGENT_BACKLOG_CATCHUP_MS,
  formatUrgentBacklogMarker,
  parseUrgentBacklogRemaining,
} from "./research-batch";

/**
 * Urgent-backlog catch-up cadence. Only the explicit marker may shorten the
 * 6-hour steady-state cadence; pacing, concurrency and budgets are untouched.
 */

const { researchCadenceMs, RESEARCH_REFRESH_HOURS, RESEARCH_ZERO_PROGRESS_RETRY_MS } = await import(
  "./research.server"
);
const { RESEARCH_DEADLINE_MS } = await import("../shadow.server");

const SIX_HOURS = RESEARCH_REFRESH_HOURS * 3600_000;

describe("urgent backlog marker", () => {
  it("round-trips a count", () => {
    expect(formatUrgentBacklogMarker(3)).toBe("Urgent backlog remaining: 3.");
    expect(parseUrgentBacklogRemaining("Bounded pass. Urgent backlog remaining: 3.")).toBe(3);
    expect(parseUrgentBacklogRemaining("Bounded pass: 1 researched, 9 deferred.")).toBeNull();
  });

  it("uses the 15-minute catch-up cadence while urgent work remains", () => {
    expect(URGENT_BACKLOG_CATCHUP_MS).toBe(15 * 60_000);
    expect(
      researchCadenceMs({
        state: "partial",
        researchedCount: 1,
        detail: `Bounded pass: 1 researched, 9 deferred. ${formatUrgentBacklogMarker(4)}`,
      }),
    ).toBe(URGENT_BACKLOG_CATCHUP_MS);
  });

  it("decrements but stays short when one urgent candidate completes and more remain", () => {
    expect(
      researchCadenceMs({ state: "partial", researchedCount: 1, detail: formatUrgentBacklogMarker(3) }),
    ).toBe(URGENT_BACKLOG_CATCHUP_MS);
  });

  it("returns to the 6-hour cadence once the urgent backlog is cleared", () => {
    expect(
      researchCadenceMs({
        state: "partial",
        researchedCount: 2,
        detail: `Bounded pass: 2 researched, 12 deferred. ${formatUrgentBacklogMarker(0)}`,
      }),
    ).toBe(SIX_HOURS);
  });

  it("does not fast-cadence on partial alone or on deferred/unresolved noise", () => {
    expect(researchCadenceMs({ state: "partial", researchedCount: 1 })).toBe(SIX_HOURS);
    expect(
      researchCadenceMs({
        state: "partial",
        researchedCount: 1,
        detail: "Unresolved handles: gghff, neo7777. Urgent backlog remaining: 0.",
      }),
    ).toBe(SIX_HOURS);
    expect(
      researchCadenceMs({ state: "success", researchedCount: 3, detail: "Bounded pass: 3 researched, 11 deferred." }),
    ).toBe(SIX_HOURS);
  });

  it("keeps the existing zero-progress error retry", () => {
    expect(researchCadenceMs({ state: "error", researchedCount: 0 })).toBe(RESEARCH_ZERO_PROGRESS_RETRY_MS);
    expect(
      researchCadenceMs({ state: "error", researchedCount: 0, detail: formatUrgentBacklogMarker(0) }),
    ).toBe(RESEARCH_ZERO_PROGRESS_RETRY_MS);
  });

  it("leaves scheduler/pass budgets untouched", () => {
    expect(RESEARCH_DEADLINE_MS).toBe(8_000);
    expect(RESEARCH_BUDGET_MS).toBe(120_000);
  });
});
