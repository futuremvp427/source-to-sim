import { describe, expect, it } from "vitest";
import { buildLatenessReport, type LatenessSample } from "./lateness";

function sample(overrides: Partial<LatenessSample> = {}): LatenessSample {
  return { venue: "PMUS", requestedDelayMs: 0, latenessMs: 100, failed: false, ...overrides };
}

describe("buildLatenessReport", () => {
  it("computes count/median/p90/p95/max over the overall sample set", () => {
    const samples = [10, 20, 30, 40, 50].map((ms) => sample({ latenessMs: ms }));
    const report = buildLatenessReport(samples);
    expect(report.overall.count).toBe(5);
    expect(report.overall.medianMs).toBe(30);
    expect(report.overall.maxMs).toBe(50);
    expect(report.overall.p90Ms).toBeGreaterThan(30);
  });

  it("buckets by every one of the five requested delays, even when a bucket has zero samples", () => {
    const samples = [sample({ requestedDelayMs: 0 }), sample({ requestedDelayMs: 5000 })];
    const report = buildLatenessReport(samples);
    expect(Object.keys(report.byRequestedDelayMs).map(Number).sort((a, b) => a - b)).toEqual([0, 5000, 10000, 30000, 60000]);
    expect(report.byRequestedDelayMs[0]?.count).toBe(1);
    expect(report.byRequestedDelayMs[10000]?.count).toBe(0);
    expect(report.byRequestedDelayMs[10000]?.medianMs).toBeNull();
  });

  it("buckets by venue", () => {
    const samples = [sample({ venue: "PMUS" }), sample({ venue: "PMUS" }), sample({ venue: "KALSHI" })];
    const report = buildLatenessReport(samples);
    expect(report.byVenue["PMUS"]?.count).toBe(2);
    expect(report.byVenue["KALSHI"]?.count).toBe(1);
  });

  it("reports failedCount/failedRate without excluding failed samples from the lateness distribution", () => {
    const samples = [sample({ failed: false, latenessMs: 100 }), sample({ failed: true, latenessMs: 9999 })];
    const report = buildLatenessReport(samples);
    expect(report.overall.count).toBe(2); // the failed sample is still counted/timed
    expect(report.overall.failedCount).toBe(1);
    expect(report.overall.failedRate).toBe(0.5);
    expect(report.overall.maxMs).toBe(9999);
  });

  it("an empty sample set produces null stats, not a crash or a fabricated zero", () => {
    const report = buildLatenessReport([]);
    expect(report.overall.count).toBe(0);
    expect(report.overall.medianMs).toBeNull();
    expect(report.overall.p90Ms).toBeNull();
    expect(report.overall.p95Ms).toBeNull();
    expect(report.overall.maxMs).toBeNull();
    expect(report.overall.failedRate).toBe(0);
  });

  it("a single sample's median/p90/p95/max all equal that one value", () => {
    const report = buildLatenessReport([sample({ latenessMs: 4200 })]);
    expect(report.overall.medianMs).toBe(4200);
    expect(report.overall.p90Ms).toBe(4200);
    expect(report.overall.p95Ms).toBe(4200);
    expect(report.overall.maxMs).toBe(4200);
  });
});
