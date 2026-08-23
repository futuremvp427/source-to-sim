import { describe, expect, it, vi } from "vitest";

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

/** A minimal Supabase-query-builder double: every chain method returns itself; awaiting it (however many chain calls deep) resolves to `result`. */
function queryBuilder(result: { data: unknown; error: unknown; count?: number | null }) {
  const builder: Record<string, unknown> = {
    select: () => builder,
    eq: () => builder,
    order: () => builder,
    limit: () => builder,
    is: () => builder,
    maybeSingle: () => builder,
    then: (resolve: (v: unknown) => void) => resolve(result),
  };
  return builder;
}

const OK = { data: null, error: null };
const ERR = { data: null, error: { message: "simulated query failure" } };

/** Builds a full 6-table supabaseAdmin double for loadSportsShadowDashboard, with per-table override. */
function mockSupabaseAdmin(overrides: Partial<Record<string, { data: unknown; error: unknown; count?: number | null }>> = {}) {
  const defaults: Record<string, { data: unknown; error: unknown; count?: number | null }> = {
    sports_shadow_experiment_epochs: { ...OK, data: null },
    sports_shadow_venue_capability: { ...OK, data: null },
    sports_shadow_signals: { ...OK, data: [] },
    sports_shadow_integrity_audits: { ...OK, data: null },
    sports_shadow_alerts: { ...OK, count: 0 },
    sports_shadow_wallet_coverage: { ...OK, data: [] },
  };
  const byTable = { ...defaults, ...overrides };
  return { from: (table: string) => queryBuilder(byTable[table] ?? OK) };
}

describe("CODEX P2-4: loadSportsShadowDashboard distinguishes a genuine empty/zero state from a query FAILURE", () => {
  async function loadWith(overrides: Partial<Record<string, { data: unknown; error: unknown; count?: number | null }>> = {}) {
    vi.doMock("@/integrations/supabase/client.server", () => ({ supabaseAdmin: mockSupabaseAdmin(overrides) }));
    vi.resetModules();
    const { loadSportsShadowDashboard } = await import("./dashboard.server");
    const data = await loadSportsShadowDashboard();
    vi.doUnmock("@/integrations/supabase/client.server");
    vi.resetModules();
    return data;
  }

  it("a healthy load reports every section NOT degraded, with genuine empty/zero values", async () => {
    const data = await loadWith();
    expect(data.degraded).toEqual({ epoch: false, capability: false, signals: false, integrity: false, alerts: false, milestones: false, results: false, coverage: false });
    expect(data.epoch).toBeNull();
    expect(data.unresolvedAlertCount).toBe(0);
    expect(data.coverageGaps).toEqual([]);
  });

  it("CODEX P1-1 (round 2): coverage query failure: degraded.coverage=true, coverageGaps falls back to empty but is NOT 'no gaps'", async () => {
    const data = await loadWith({ sports_shadow_wallet_coverage: ERR });
    expect(data.degraded.coverage).toBe(true);
    expect(data.coverageGaps).toEqual([]);
  });

  it("CODEX P1-1 (round 2): a genuine unresolved coverage gap surfaces with its wallet and reason", async () => {
    const data = await loadWith({
      sports_shadow_wallet_coverage: { ...OK, data: [{ wallet: "0xgap", coverage_complete: false, incomplete_reason: "steady-state gap" }] },
    });
    expect(data.degraded.coverage).toBe(false);
    expect(data.coverageGaps).toEqual([{ wallet: "0xgap", incompleteReason: "steady-state gap" }]);
  });

  it("epoch query failure: degraded.epoch=true, epoch stays null, milestones/results ALSO degrade (their correctness depends on knowing the current epoch)", async () => {
    const data = await loadWith({ sports_shadow_experiment_epochs: ERR });
    expect(data.degraded.epoch).toBe(true);
    expect(data.degraded.milestones).toBe(true);
    expect(data.degraded.results).toBe(true);
    expect(data.epoch).toBeNull();
  });

  it("capability query failure (either venue): degraded.capability=true, both capabilities null -- never rendered as 'not yet checked'", async () => {
    const data = await loadWith({ sports_shadow_venue_capability: ERR });
    expect(data.degraded.capability).toBe(true);
    expect(data.pmusCapability).toBeNull();
    expect(data.kalshiCapability).toBeNull();
  });

  it("signals query failure: degraded.signals=true, wallets stays empty but is NOT 'no source activity'", async () => {
    const data = await loadWith({ sports_shadow_signals: ERR });
    expect(data.degraded.signals).toBe(true);
    expect(data.wallets).toEqual([]);
  });

  it("integrity query failure: degraded.integrity=true, distinct from a genuine 'audit never run' (passed=null either way, but the flag disambiguates)", async () => {
    const data = await loadWith({ sports_shadow_integrity_audits: ERR });
    expect(data.degraded.integrity).toBe(true);
    expect(data.integrity.passed).toBeNull();
  });

  it("alerts query failure: degraded.alerts=true, unresolvedAlertCount falls back to 0 but is NOT a genuine zero", async () => {
    const data = await loadWith({ sports_shadow_alerts: ERR });
    expect(data.degraded.alerts).toBe(true);
    expect(data.unresolvedAlertCount).toBe(0);
  });

  it("milestone/results computation failure (a REAL epoch exists, but getEpochCounters/fetchAllEpisodeOutcomes throws): only milestones/results degrade -- epoch itself is still known and healthy", async () => {
    const epochRow = {
      id: "epoch-1",
      go_live_at: "2026-08-01T00:00:00Z",
      wallet_cohort: ["0xa"],
      stage: "OPERATIONAL_SOAK",
      stage_entered_at: "2026-08-01T00:00:00Z",
      git_sha: "abc123",
      config_hash: "hash1",
      calibration_started_at: null,
      oos_started_at: null,
    };
    vi.doMock("@/integrations/supabase/client.server", () => ({
      supabaseAdmin: mockSupabaseAdmin({ sports_shadow_experiment_epochs: { ...OK, data: epochRow } }),
    }));
    vi.doMock("./counters.server", () => ({
      getEpochCounters: async () => {
        throw new Error("simulated counters RPC failure");
      },
      nextMilestoneFor: () => null,
    }));
    vi.doMock("./analytics.server", () => ({
      fetchAllEpisodeOutcomes: async () => {
        throw new Error("simulated episode-outcomes fetch failure");
      },
      computeEpisodeAnalysisReport: () => ({}),
    }));
    vi.doMock("./classification.server", () => ({
      evaluateCalibrationClassification: async () => null,
      evaluateOosClassification: async () => null,
    }));
    vi.resetModules();
    const { loadSportsShadowDashboard } = await import("./dashboard.server");
    const data = await loadSportsShadowDashboard();
    expect(data.degraded.epoch).toBe(false);
    expect(data.epoch?.id).toBe("epoch-1");
    expect(data.degraded.milestones).toBe(true);
    expect(data.degraded.results).toBe(true); // fetchAllEpisodeOutcomes throwing degrades results independently
    vi.doUnmock("@/integrations/supabase/client.server");
    vi.doUnmock("./counters.server");
    vi.doUnmock("./analytics.server");
    vi.doUnmock("./classification.server");
    vi.resetModules();
  });
});
