import { describe, expect, it } from "vitest";

import { summarizeLatency } from "./latency-core";

const base = {
  sourceTs: 1_700_000_000,
  detectedAt: "2023-11-14T22:13:40.000Z", // +20s
  eventPersistedAt: "2023-11-14T22:13:42.000Z", // +2s
  decisionAt: "2023-11-14T22:13:45.000Z", // +3s
};

describe("summarizeLatency", () => {
  it("returns nulls with no samples", () => {
    const out = summarizeLatency([]);
    expect(out.samples).toBe(0);
    expect(out.medianSourceToDecisionSeconds).toBeNull();
  });

  it("splits the pipeline into named stages", () => {
    const out = summarizeLatency([base]);
    expect(out.medianPublishPollSeconds).toBe(20);
    expect(out.medianIngestSeconds).toBe(2);
    expect(out.medianDecisionSeconds).toBe(3);
    expect(out.medianSourceToDecisionSeconds).toBe(25);
  });

  it("never reports a missing stage as zero", () => {
    const out = summarizeLatency([{ ...base, eventPersistedAt: null }]);
    expect(out.medianIngestSeconds).toBeNull();
    expect(out.medianDecisionSeconds).toBeNull();
    expect(out.medianPublishPollSeconds).toBe(20);
    expect(out.medianSourceToDecisionSeconds).toBe(25);
  });

  it("drops negative intervals caused by clock skew", () => {
    const out = summarizeLatency([{ ...base, sourceTs: 1_700_000_100 }]);
    expect(out.medianPublishPollSeconds).toBeNull();
    expect(out.medianSourceToDecisionSeconds).toBeNull();
  });
});