import { describe, expect, it } from "vitest";
import { admit, admitAll, admittedSourceKinds, LookaheadError, type ProvenancedDatum, type StalenessPolicy } from "./provenance";

const T = (iso: string) => new Date(iso);
const DECISION = T("2026-08-27T17:00:00Z");
const POLICY: StalenessPolicy = { maxIssueAgeMs: 6 * 3600_000, maxRetrievalAgeMs: 10 * 60_000 };

const datum = (over: Partial<ProvenancedDatum<number>> = {}): ProvenancedDatum<number> => ({
  source: "NBM",
  sourceId: "nbm/KNYC",
  issuedAt: T("2026-08-27T13:00:00Z"),
  validAt: T("2026-08-28T00:00:00Z"),
  retrievedAt: T("2026-08-27T16:55:00Z"),
  value: 84,
  ...over,
});

describe("admit", () => {
  it("admits a fresh datum issued before the decision", () => {
    const r = admit(datum(), DECISION, POLICY);
    expect(r.admitted).toBe(true);
  });

  it("throws rather than silently skipping when issuedAt is after the decision", () => {
    expect(() => admit(datum({ issuedAt: T("2026-08-27T18:00:00Z") }), DECISION, POLICY)).toThrow(LookaheadError);
  });

  it("throws when retrievedAt is after the decision", () => {
    expect(() => admit(datum({ retrievedAt: T("2026-08-27T17:30:00Z") }), DECISION, POLICY)).toThrow(LookaheadError);
  });

  it("allows validAt in the future, which is what a forecast is", () => {
    const r = admit(datum({ validAt: T("2026-12-01T00:00:00Z") }), DECISION, POLICY);
    expect(r.admitted).toBe(true);
  });

  it("rejects, without throwing, a forecast issued too long ago", () => {
    const r = admit(datum({ issuedAt: T("2026-08-27T02:00:00Z") }), DECISION, POLICY);
    expect(r.admitted).toBe(false);
    if (!r.admitted) expect(r.reason).toMatch(/stale/);
  });

  it("rejects a datum retrieved too long ago, catching a frozen cache", () => {
    const r = admit(datum({ retrievedAt: T("2026-08-27T16:00:00Z") }), DECISION, POLICY);
    expect(r.admitted).toBe(false);
    if (!r.admitted) expect(r.reason).toMatch(/retrieved/);
  });

  it("rejects invalid dates", () => {
    const r = admit(datum({ issuedAt: new Date("nonsense") }), DECISION, POLICY);
    expect(r.admitted).toBe(false);
  });

  it("admits a datum issued exactly at the decision instant", () => {
    const r = admit(datum({ issuedAt: DECISION, retrievedAt: DECISION }), DECISION, POLICY);
    expect(r.admitted).toBe(true);
  });
});

describe("admitAll", () => {
  it("separates admitted feeds from rejected ones with reasons", () => {
    const { admitted, rejected } = admitAll(
      [
        datum({ sourceId: "fresh" }),
        datum({ sourceId: "stale", issuedAt: T("2026-08-26T00:00:00Z") }),
      ],
      DECISION,
      POLICY,
    );
    expect(admitted.map((d) => d.sourceId)).toEqual(["fresh"]);
    expect(rejected).toHaveLength(1);
    expect(rejected[0]?.sourceId).toBe("stale");
  });

  it("still throws on lookahead inside a batch", () => {
    expect(() =>
      admitAll([datum(), datum({ issuedAt: T("2026-08-27T23:00:00Z") })], DECISION, POLICY),
    ).toThrow(LookaheadError);
  });
});

describe("admittedSourceKinds", () => {
  it("reports distinct sorted model families", () => {
    const kinds = admittedSourceKinds([
      datum({ source: "HRRR" }),
      datum({ source: "NBM" }),
      datum({ source: "HRRR" }),
    ]);
    expect(kinds).toEqual(["HRRR", "NBM"]);
  });
});
