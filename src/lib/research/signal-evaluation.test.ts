import { describe, expect, it } from "vitest";

import {
  brierScore,
  calibrationBuckets,
  clusteredBootstrapCi,
  compareIncrementalValue,
  groupByCluster,
  logLoss,
  type Observation,
} from "./signal-evaluation";

describe("brierScore", () => {
  it("is 0 for a perfect predictor", () => {
    const obs: Observation[] = [
      { p: 1, y: 1, clusterKey: "a" },
      { p: 0, y: 0, clusterKey: "b" },
    ];
    expect(brierScore(obs)).toBe(0);
  });

  it("is 1 for a maximally wrong predictor", () => {
    const obs: Observation[] = [
      { p: 1, y: 0, clusterKey: "a" },
      { p: 0, y: 1, clusterKey: "b" },
    ];
    expect(brierScore(obs)).toBe(1);
  });

  it("is 0.25 for a coin-flip predictor on either outcome", () => {
    const obs: Observation[] = [
      { p: 0.5, y: 1, clusterKey: "a" },
      { p: 0.5, y: 0, clusterKey: "b" },
    ];
    expect(brierScore(obs)).toBe(0.25);
  });

  it("is null for an empty set (never divides by zero)", () => {
    expect(brierScore([])).toBeNull();
  });
});

describe("logLoss", () => {
  it("is near 0 for a confident correct predictor", () => {
    const obs: Observation[] = [{ p: 0.99, y: 1, clusterKey: "a" }];
    expect(logLoss(obs)!).toBeLessThan(0.02);
  });

  it("is large for a confident WRONG predictor (penalizes overconfidence)", () => {
    const obs: Observation[] = [{ p: 0.99, y: 0, clusterKey: "a" }];
    expect(logLoss(obs)!).toBeGreaterThan(3);
  });

  it("clamps probabilities away from exactly 0/1 so it never returns Infinity/NaN", () => {
    const obs: Observation[] = [
      { p: 1, y: 0, clusterKey: "a" },
      { p: 0, y: 1, clusterKey: "b" },
    ];
    const result = logLoss(obs)!;
    expect(Number.isFinite(result)).toBe(true);
  });

  it("is null for an empty set", () => {
    expect(logLoss([])).toBeNull();
  });
});

describe("calibrationBuckets", () => {
  it("reports mean predicted vs mean realized per bucket", () => {
    const obs: Observation[] = [
      { p: 0.1, y: 0, clusterKey: "a" },
      { p: 0.15, y: 0, clusterKey: "b" },
      { p: 0.85, y: 1, clusterKey: "c" },
      { p: 0.9, y: 1, clusterKey: "d" },
    ];
    const buckets = calibrationBuckets(obs);
    const low = buckets[0]!;
    expect(low.n).toBe(2);
    expect(low.meanPredicted).toBeCloseTo(0.125, 6);
    expect(low.meanRealized).toBe(0);
    const high = buckets[buckets.length - 1]!;
    expect(high.n).toBe(2);
    expect(high.meanRealized).toBe(1);
  });

  it("empty buckets report null means, not NaN or 0", () => {
    const buckets = calibrationBuckets([{ p: 0.5, y: 1, clusterKey: "a" }]);
    const emptyBucket = buckets.find((b) => b.n === 0)!;
    expect(emptyBucket.meanPredicted).toBeNull();
    expect(emptyBucket.meanRealized).toBeNull();
  });
});

describe("groupByCluster", () => {
  it("groups observations sharing a clusterKey together", () => {
    const obs: Observation[] = [
      { p: 0.5, y: 1, clusterKey: "nyc:2026-06-01" },
      { p: 0.6, y: 1, clusterKey: "nyc:2026-06-01" },
      { p: 0.4, y: 0, clusterKey: "la:2026-06-02" },
    ];
    const clusters = groupByCluster(obs);
    expect(clusters).toHaveLength(2);
    expect(clusters.find((c) => c[0]!.clusterKey === "nyc:2026-06-01")).toHaveLength(2);
  });
});

describe("clusteredBootstrapCi", () => {
  it("returns null with fewer than 2 clusters (a CI is not meaningful)", () => {
    const clusters = groupByCluster([{ p: 0.5, y: 1, clusterKey: "only-one" }]);
    const result = clusteredBootstrapCi(clusters, (o) => brierScore(o));
    expect(result).toBeNull();
  });

  it("is deterministic for a fixed seed", () => {
    const obs: Observation[] = Array.from({ length: 40 }, (_, i) => ({
      p: 0.3 + (i % 5) * 0.1,
      y: (i % 2) as 0 | 1,
      clusterKey: `c${i % 8}`,
    }));
    const clusters = groupByCluster(obs);
    const a = clusteredBootstrapCi(clusters, (o) => brierScore(o), { seed: 7, iterations: 200 });
    const b = clusteredBootstrapCi(clusters, (o) => brierScore(o), { seed: 7, iterations: 200 });
    expect(a).toEqual(b);
  });

  it("resamples whole clusters, not individual rows -- an extreme single-row cluster cannot dominate every resample the way it would with row-level resampling", () => {
    // 10 clusters of 1 well-behaved row each, plus one outlier cluster of 50
    // extreme rows. Row-level bootstrap would draw mostly from the 50-row
    // outlier cluster; cluster-level bootstrap draws each cluster with equal
    // probability regardless of its internal row count.
    const wellBehaved: Observation[] = Array.from({ length: 10 }, (_, i) => ({
      p: 0.5,
      y: (i % 2) as 0 | 1,
      clusterKey: `c${i}`,
    }));
    const outlierCluster: Observation[] = Array.from({ length: 50 }, () => ({
      p: 0.99,
      y: 0 as const,
      clusterKey: "outlier",
    }));
    const clusters = groupByCluster([...wellBehaved, ...outlierCluster]);
    expect(clusters).toHaveLength(11);
    const result = clusteredBootstrapCi(clusters, (o) => brierScore(o), {
      seed: 1,
      iterations: 2000,
    });
    // If row-level resampling were used, the point estimate (computed on all
    // rows) would be dominated by the 50 outlier rows (Brier near 0.98).
    // Cluster-level point estimate should still reflect the flat brier
    // score across all rows for the POINT estimate (unbiased), but the CI
    // width should be wide because the outlier cluster is just 1 of 11
    // equally-weighted resampling units, producing high resample variance.
    expect(result).not.toBeNull();
    expect(result!.ciHigh - result!.ciLow).toBeGreaterThan(0.1);
  });
});

describe("compareIncrementalValue", () => {
  function makeParallel(
    n: number,
    baselineP: (i: number) => number,
    walletP: (i: number) => number,
    combinedP: (i: number) => number,
    y: (i: number) => 0 | 1,
    clusterOf: (i: number) => string,
  ) {
    const baseline: Observation[] = [];
    const wallet: Observation[] = [];
    const combined: Observation[] = [];
    for (let i = 0; i < n; i += 1) {
      const key = clusterOf(i);
      const outcome = y(i);
      baseline.push({ p: baselineP(i), y: outcome, clusterKey: key });
      wallet.push({ p: walletP(i), y: outcome, clusterKey: key });
      combined.push({ p: combinedP(i), y: outcome, clusterKey: key });
    }
    return { baseline, wallet, combined };
  }

  it("reports INSUFFICIENT_DATA with fewer than 2 clusters, never a false-confident verdict", () => {
    const { baseline, wallet, combined } = makeParallel(
      5,
      () => 0.5,
      () => 0.5,
      () => 0.5,
      (i) => (i % 2) as 0 | 1,
      () => "single-cluster",
    );
    const result = compareIncrementalValue(baseline, wallet, combined);
    expect(result.verdict).toBe("INSUFFICIENT_DATA");
    expect(result.brierImprovementCi).toBeNull();
  });

  it("MATERIAL_IMPROVEMENT when combined predictions are reliably closer to the truth than baseline alone", () => {
    // Baseline always predicts 0.5 (uninformative). Combined predicts the
    // true outcome almost exactly. Many independent clusters.
    const { baseline, wallet, combined } = makeParallel(
      200,
      () => 0.5,
      (i) => (i % 2 === 0 ? 0.9 : 0.1),
      (i) => (i % 2 === 0 ? 0.95 : 0.05),
      (i) => (i % 2 === 0 ? 1 : 0) as 0 | 1,
      (i) => `cluster${i}`, // each observation its own cluster: 200 independent clusters
    );
    const result = compareIncrementalValue(baseline, wallet, combined, { iterations: 500 });
    expect(result.verdict).toBe("MATERIAL_IMPROVEMENT");
    expect(result.combined.brier!).toBeLessThan(result.baselineOnly.brier!);
    expect(result.brierImprovementCi!.ciHigh).toBeLessThan(0);
  });

  it("NO_MATERIAL_IMPROVEMENT when combined is statistically indistinguishable from baseline", () => {
    const { baseline, wallet, combined } = makeParallel(
      100,
      (i) => (i % 2 === 0 ? 0.6 : 0.4),
      () => 0.5, // wallet signal is pure noise
      (i) => (i % 2 === 0 ? 0.6 : 0.4), // combined ignores the noisy wallet signal, same as baseline
      (i) => (i % 2 === 0 ? 1 : 0) as 0 | 1,
      (i) => `cluster${i}`,
    );
    const result = compareIncrementalValue(baseline, wallet, combined, { iterations: 500 });
    expect(result.verdict).toBe("NO_MATERIAL_IMPROVEMENT");
  });

  it("collapsing many same-city-day trades into few clusters changes the verdict vs. treating them as independent (demonstrates why clustering is required)", () => {
    // 10 "trades" all in the same city-day, all agreeing (combined
    // consistently a hair better than baseline) -- but they are ONE cluster,
    // so the bootstrap CANNOT manufacture false precision from repeating the
    // same city-day 10 times over.
    const { baseline, combined, wallet } = makeParallel(
      10,
      () => 0.5,
      () => 0.6,
      () => 0.55,
      () => 1,
      () => "nyc:2026-06-01", // single cluster
    );
    const result = compareIncrementalValue(baseline, wallet, combined, { iterations: 500 });
    // Only 1 cluster -> INSUFFICIENT_DATA, not a confident MATERIAL_IMPROVEMENT
    // a naive (unclustered) 10-observation bootstrap might have produced.
    expect(result.verdict).toBe("INSUFFICIENT_DATA");
  });
});
