import { describe, expect, it } from "vitest";
import {
  BucketParseError,
  bucketContains,
  parseBucket,
  resolveBucket,
  validateBucketSet,
  type RawKalshiMarket,
} from "./buckets";

/** Verbatim shape of the live KXHIGHNY-26AUG27 event observed on Kalshi. */
const NYC_AUG27: RawKalshiMarket[] = [
  { ticker: "KXHIGHNY-26AUG27-T80", strike_type: "less", cap_strike: 80, yes_sub_title: "79° or below" },
  { ticker: "KXHIGHNY-26AUG27-B80.5", strike_type: "between", floor_strike: 80, cap_strike: 81, yes_sub_title: "80° to 81°" },
  { ticker: "KXHIGHNY-26AUG27-B82.5", strike_type: "between", floor_strike: 82, cap_strike: 83, yes_sub_title: "82° to 83°" },
  { ticker: "KXHIGHNY-26AUG27-B84.5", strike_type: "between", floor_strike: 84, cap_strike: 85, yes_sub_title: "84° to 85°" },
  { ticker: "KXHIGHNY-26AUG27-B86.5", strike_type: "between", floor_strike: 86, cap_strike: 87, yes_sub_title: "86° to 87°" },
  { ticker: "KXHIGHNY-26AUG27-T87", strike_type: "greater", floor_strike: 87, yes_sub_title: "88° or above" },
];

describe("parseBucket", () => {
  it("applies the off-by-one for 'less' so cap_strike 80 means 79 or below", () => {
    const b = parseBucket(NYC_AUG27[0]!);
    expect(b.lowerF).toBeNull();
    expect(b.upperF).toBe(79);
  });

  it("applies the off-by-one for 'greater' so floor_strike 87 means 88 or above", () => {
    const b = parseBucket(NYC_AUG27[5]!);
    expect(b.lowerF).toBe(88);
    expect(b.upperF).toBeNull();
  });

  it("treats 'between' bounds as inclusive", () => {
    const b = parseBucket(NYC_AUG27[1]!);
    expect(b.lowerF).toBe(80);
    expect(b.upperF).toBe(81);
  });

  it("fails closed on an unknown strike type", () => {
    expect(() => parseBucket({ ticker: "X", strike_type: "wat" })).toThrow(BucketParseError);
  });

  it("fails closed on a missing strike bound", () => {
    expect(() => parseBucket({ ticker: "X", strike_type: "less", cap_strike: null })).toThrow(BucketParseError);
    expect(() => parseBucket({ ticker: "X", strike_type: "greater" })).toThrow(BucketParseError);
    expect(() => parseBucket({ ticker: "X", strike_type: "between", floor_strike: 80 })).toThrow(BucketParseError);
  });

  it("fails closed on a non-integer strike", () => {
    expect(() => parseBucket({ ticker: "X", strike_type: "between", floor_strike: 80.5, cap_strike: 81 })).toThrow(
      BucketParseError,
    );
  });

  it("fails closed when cap is below floor", () => {
    expect(() => parseBucket({ ticker: "X", strike_type: "between", floor_strike: 85, cap_strike: 80 })).toThrow(
      BucketParseError,
    );
  });
});

describe("validateBucketSet", () => {
  it("accepts the real six-leg NYC event as exhaustive and mutually exclusive", () => {
    const r = validateBucketSet(NYC_AUG27.map(parseBucket));
    expect(r.status).toBe("VALID");
    expect(r.buckets).toHaveLength(6);
  });

  it("rejects a set with a one-degree gap", () => {
    const withGap = NYC_AUG27.filter((m) => !m.ticker.endsWith("B82.5")).map(parseBucket);
    const r = validateBucketSet(withGap);
    expect(r.status).toBe("INVALID");
    if (r.status === "INVALID") expect(r.reason).toMatch(/gap/);
  });

  it("rejects overlapping buckets", () => {
    const overlapping = [
      ...NYC_AUG27.map(parseBucket),
      { ticker: "DUP", lowerF: 84, upperF: 85, label: "84° to 85°" },
    ];
    const r = validateBucketSet(overlapping);
    expect(r.status).toBe("INVALID");
  });

  it("rejects a set with no unbounded tail", () => {
    const bounded = NYC_AUG27.slice(1, 5).map(parseBucket);
    const r = validateBucketSet(bounded);
    expect(r.status).toBe("INVALID");
  });

  it("rejects a set with two unbounded-above buckets", () => {
    const twoTails = [
      ...NYC_AUG27.map(parseBucket),
      { ticker: "EXTRA", lowerF: 200, upperF: null, label: "200+" },
    ];
    const r = validateBucketSet(twoTails);
    expect(r.status).toBe("INVALID");
    if (r.status === "INVALID") expect(r.reason).toMatch(/unbounded-above/);
  });

  it("rejects a single-bucket set", () => {
    expect(validateBucketSet([parseBucket(NYC_AUG27[0]!)]).status).toBe("INVALID");
  });
});

describe("bucketContains / resolveBucket", () => {
  const buckets = NYC_AUG27.map(parseBucket);

  it("includes both inclusive endpoints", () => {
    const b = buckets.find((x) => x.ticker.endsWith("B84.5"))!;
    expect(bucketContains(b, 84)).toBe(true);
    expect(bucketContains(b, 85)).toBe(true);
    expect(bucketContains(b, 83)).toBe(false);
    expect(bucketContains(b, 86)).toBe(false);
  });

  it("resolves exactly one bucket for any temperature", () => {
    for (const t of [50, 79, 80, 81, 85, 87, 88, 120]) {
      expect(resolveBucket(buckets, t)).not.toBeNull();
    }
  });

  it("resolves the boundary case that the off-by-one would break", () => {
    // 79 must be the 'or below' bucket, and 80 must be the first range bucket.
    expect(resolveBucket(buckets, 79)!.ticker).toMatch(/T80$/);
    expect(resolveBucket(buckets, 80)!.ticker).toMatch(/B80\.5$/);
    expect(resolveBucket(buckets, 88)!.ticker).toMatch(/T87$/);
  });

  it("returns null when the set is malformed and matches more than one bucket", () => {
    const dup = [...buckets, { ticker: "DUP", lowerF: 84, upperF: 85, label: "dup" }];
    expect(resolveBucket(dup, 84)).toBeNull();
  });
});
