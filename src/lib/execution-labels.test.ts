import { describe, expect, it } from "vitest";

import {
  EXECUTION_ADJUSTED_PNL_LABEL,
  RAW_IDEALIZED_PNL_LABEL,
  labelExecutionAdjustedPnl,
  labelRawIdealizedPnl,
} from "./execution-labels";

/**
 * Phase 0A remediation, item 2: regression coverage preventing the raw,
 * idealized paper P&L from ever being presented (or silently mistaken for)
 * a realistic/executable result.
 */
describe("labelRawIdealizedPnl", () => {
  it("always marks the value idealized and never executable, regardless of sign", () => {
    for (const value of [149.84, -655.39, 0]) {
      const labeled = labelRawIdealizedPnl(value);
      expect(labeled.value).toBe(value);
      expect(labeled.label).toBe(RAW_IDEALIZED_PNL_LABEL);
      expect(labeled.isIdealized).toBe(true);
      expect(labeled.isExecutable).toBe(false);
    }
  });

  it("caveat text explicitly disclaims realism/executability", () => {
    const labeled = labelRawIdealizedPnl(100);
    expect(labeled.caveat).toMatch(/source wallet/i);
    expect(labeled.caveat).toMatch(/no .*spread/i);
    expect(labeled.caveat).toMatch(/NOT a realistic or executable/i);
  });

  it("the label field cannot be widened at the type level to any other string (compile-time guarantee, checked at runtime too)", () => {
    const labeled = labelRawIdealizedPnl(1);
    expect(labeled.label).not.toBe(EXECUTION_ADJUSTED_PNL_LABEL);
  });
});

describe("labelExecutionAdjustedPnl", () => {
  it("is explicitly unavailable (not zero, not equal to any raw figure) when no adjusted value exists", () => {
    const labeled = labelExecutionAdjustedPnl(null, { source: "observation_log" });
    expect(labeled.available).toBe(false);
    expect(labeled.value).toBeNull();
    if (!labeled.available) expect(typeof labeled.reason).toBe("string");
  });

  it("uses the supplied unavailable reason verbatim when given", () => {
    const labeled = labelExecutionAdjustedPnl(null, {
      source: "observation_log",
      unavailableReason: "custom reason",
    });
    if (!labeled.available) expect(labeled.reason).toBe("custom reason");
  });

  it("is available and carries the value, label, and source when supplied", () => {
    const labeled = labelExecutionAdjustedPnl(-720.1, { source: "observation_log" });
    expect(labeled.available).toBe(true);
    if (labeled.available) {
      expect(labeled.value).toBe(-720.1);
      expect(labeled.label).toBe(EXECUTION_ADJUSTED_PNL_LABEL);
      expect(labeled.isExecutable).toBe(false); // still an estimate, never claims executability
      expect(labeled.isIdealized).toBe(false);
      expect(labeled.source).toBe("observation_log");
    }
  });

  it("treats an adjusted value of exactly 0 as available, distinct from unavailable", () => {
    const labeled = labelExecutionAdjustedPnl(0, { source: "observation_log" });
    expect(labeled.available).toBe(true);
    if (labeled.available) expect(labeled.value).toBe(0);
  });

  it("raw and execution-adjusted labels are never equal to each other", () => {
    expect(RAW_IDEALIZED_PNL_LABEL).not.toBe(EXECUTION_ADJUSTED_PNL_LABEL);
  });
});
