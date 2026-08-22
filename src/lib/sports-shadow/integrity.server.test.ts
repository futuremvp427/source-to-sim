import { describe, expect, it } from "vitest";

import { runIntegrityAudit, type Check } from "./integrity.server";

describe("FINAL BUILD Part 26: runIntegrityAudit orchestration", () => {
  it("passed=true when every check passes", async () => {
    const checks: Check[] = [
      { name: "a", run: async () => ({ check: "a", passed: true, detail: "ok" }) },
      { name: "b", run: async () => ({ check: "b", passed: true, detail: "ok" }) },
    ];
    const result = await runIntegrityAudit(checks);
    expect(result.passed).toBe(true);
    expect(result.checksRun).toBe(2);
    expect(result.checksFailed).toBe(0);
  });

  it("passed=false and checksFailed counts correctly when some checks fail", async () => {
    const checks: Check[] = [
      { name: "a", run: async () => ({ check: "a", passed: true, detail: "ok" }) },
      { name: "b", run: async () => ({ check: "b", passed: false, detail: "found a problem" }) },
    ];
    const result = await runIntegrityAudit(checks);
    expect(result.passed).toBe(false);
    expect(result.checksFailed).toBe(1);
  });

  it("one check throwing is captured as a failed finding for THAT check, never aborts the remaining checks", async () => {
    const checks: Check[] = [
      {
        name: "throws",
        run: async () => {
          throw new Error("query exploded");
        },
      },
      { name: "still-runs", run: async () => ({ check: "still-runs", passed: true, detail: "ok" }) },
    ];
    const result = await runIntegrityAudit(checks);
    expect(result.checksRun).toBe(2);
    expect(result.findings.find((f) => f.check === "throws")?.passed).toBe(false);
    expect(result.findings.find((f) => f.check === "throws")?.detail).toMatch(/query exploded/);
    expect(result.findings.find((f) => f.check === "still-runs")?.passed).toBe(true);
  });
});
