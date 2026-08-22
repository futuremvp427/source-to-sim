import { describe, expect, it } from "vitest";

import { runIntegrityAudit, type Check, type IntegrityAuditResult } from "./integrity.server";

/** Soak-incident guard: tests must NEVER write synthetic audit rows to production (see integrity.server.ts's own doc comment) -- every call injects this in-memory recorder. */
const recorded: IntegrityAuditResult[] = [];
const record = async (result: IntegrityAuditResult) => {
  recorded.push(result);
};

describe("FINAL BUILD Part 26: runIntegrityAudit orchestration", () => {
  it("passed=true when every check passes", async () => {
    const checks: Check[] = [
      { name: "a", run: async () => ({ check: "a", passed: true, detail: "ok" }) },
      { name: "b", run: async () => ({ check: "b", passed: true, detail: "ok" }) },
    ];
    const result = await runIntegrityAudit(checks, record);
    expect(result.passed).toBe(true);
    expect(result.checksRun).toBe(2);
    expect(result.checksFailed).toBe(0);
  });

  it("passed=false and checksFailed counts correctly when some checks fail", async () => {
    const checks: Check[] = [
      { name: "a", run: async () => ({ check: "a", passed: true, detail: "ok" }) },
      { name: "b", run: async () => ({ check: "b", passed: false, detail: "found a problem" }) },
    ];
    const result = await runIntegrityAudit(checks, record);
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
    const result = await runIntegrityAudit(checks, record);
    expect(result.checksRun).toBe(2);
    expect(result.findings.find((f) => f.check === "throws")?.passed).toBe(false);
    expect(result.findings.find((f) => f.check === "throws")?.detail).toMatch(/query exploded/);
    expect(result.findings.find((f) => f.check === "still-runs")?.passed).toBe(true);
  });
});

describe("soak incident: audit persistence is injectable so tests never reach production", () => {
  it("routes the audit record through the injected recorder, not a hardcoded client", async () => {
    recorded.length = 0;
    const result = await runIntegrityAudit([{ name: "ok", run: async () => ({ check: "ok", passed: true, detail: "ok" }) }], record);
    expect(recorded).toHaveLength(1);
    expect(recorded[0]).toEqual(result);
  });
});
