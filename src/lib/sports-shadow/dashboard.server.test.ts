import { describe, expect, it } from "vitest";

import { computeMilestoneProgress, summarizeWallets, type DashboardSignalRow } from "./dashboard.server";

function row(overrides: Partial<DashboardSignalRow> = {}): DashboardSignalRow {
  return { source_wallet: "0xa", cluster_key: "cluster-1", status: "OPEN", created_at: "2026-08-19T00:00:00Z", ...overrides };
}

describe("FINAL BUILD Part 28: summarizeWallets", () => {
  it("aggregates episode counts per wallet and sorts by most recent activity first", () => {
    const rows = [
      row({ source_wallet: "0xa", created_at: "2026-08-19T00:00:00Z" }),
      row({ source_wallet: "0xa", created_at: "2026-08-20T00:00:00Z" }),
      row({ source_wallet: "0xb", created_at: "2026-08-21T00:00:00Z" }),
    ];
    const wallets = summarizeWallets(rows);
    expect(wallets).toHaveLength(2);
    expect(wallets[0]?.wallet).toBe("0xb"); // most recent activity first
    expect(wallets.find((w) => w.wallet === "0xa")?.episodeCount).toBe(2);
  });

  it("respects the limit parameter", () => {
    const rows = Array.from({ length: 20 }, (_, i) => row({ source_wallet: `0x${i}`, created_at: `2026-08-${(i % 28) + 1}T00:00:00Z` }));
    expect(summarizeWallets(rows, 5)).toHaveLength(5);
  });

  it("empty input produces an empty list", () => {
    expect(summarizeWallets([])).toHaveLength(0);
  });
});

describe("FINAL BUILD Part 28: computeMilestoneProgress", () => {
  it("100 correlated signals in ONE cluster count as 1 independent episode, matching independence.ts's own rule", () => {
    const rows = Array.from({ length: 100 }, () => row({ cluster_key: "same-game" }));
    const progress = computeMilestoneProgress(rows);
    expect(progress.rawEpisodeCount).toBe(100);
    expect(progress.independentEpisodeCount).toBe(1);
  });

  it("only SETTLED-status signals count toward settledIndependentCount", () => {
    const rows = [row({ cluster_key: "a", status: "OPEN" }), row({ cluster_key: "b", status: "SETTLED_WIN" }), row({ cluster_key: "c", status: "SETTLED_LOSS" })];
    const progress = computeMilestoneProgress(rows);
    expect(progress.settledIndependentCount).toBe(2);
    expect(progress.independentEpisodeCount).toBe(3);
  });

  it("nextMilestone is 100_INDEPENDENT_SETTLED below 100, 300_INDEPENDENT_SETTLED between 100 and 300, and null at/above 300", () => {
    const below = computeMilestoneProgress(Array.from({ length: 50 }, (_, i) => row({ cluster_key: `c${i}`, status: "SETTLED_WIN" })));
    expect(below.nextMilestone).toBe("100_INDEPENDENT_SETTLED");
    const mid = computeMilestoneProgress(Array.from({ length: 150 }, (_, i) => row({ cluster_key: `c${i}`, status: "SETTLED_WIN" })));
    expect(mid.nextMilestone).toBe("300_INDEPENDENT_SETTLED");
    const done = computeMilestoneProgress(Array.from({ length: 300 }, (_, i) => row({ cluster_key: `c${i}`, status: "SETTLED_WIN" })));
    expect(done.nextMilestone).toBeNull();
  });

  it("a signal missing cluster_key is never merged with another missing-cluster_key signal from a different wallet/time", () => {
    const rows = [
      row({ source_wallet: "0xa", cluster_key: null, created_at: "t1" }),
      row({ source_wallet: "0xb", cluster_key: null, created_at: "t2" }),
    ];
    const progress = computeMilestoneProgress(rows);
    expect(progress.independentEpisodeCount).toBe(2);
  });
});
