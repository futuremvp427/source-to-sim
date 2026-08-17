import { describe, expect, it, vi } from "vitest";

/**
 * Regression for the CRYPTO-scope candidate follower. A post-follow fill outside
 * the experiment's market_scope must be CONSUMED (so it is never retried) while
 * leaving paper cash, realized P&L, paper_positions and SKIP statistics
 * completely untouched. ALL-scope behaviour must stay byte-for-byte identical.
 */

type Commit = Record<string, unknown>;

const commits: Commit[] = [];
let pendingRows: Record<string, unknown>[] = [];

function thenable(data: unknown) {
  const name = (data as { __name?: string }).__name ?? "";
  const chain = {
    select: () => chain,
    eq: () => chain,
    in: () => chain,
    abortSignal: () => chain,
    then: (resolve: (v: { data: unknown; error: unknown }) => void) => {
      if (name === "process_source_event_atomic") {
        commits.push((data as { payload: Commit }).payload);
        resolve({ data: { processed: true, applied: true }, error: null });
        return;
      }
      resolve({ data: (data as { rows?: unknown }).rows ?? [], error: null });
    },
  };
  return chain;
}

vi.mock("@/integrations/supabase/client.server", () => ({
  supabaseAdmin: {
    rpc: (name: string, args: Record<string, unknown>) => {
      if (name === "get_pending_experiment_source_events") {
        return thenable({ __name: name, rows: pendingRows });
      }
      if (name === "process_source_event_atomic") {
        return thenable({ __name: name, payload: args["p_event"] as Commit });
      }
      return thenable({ __name: name, rows: [] });
    },
    from: () => thenable({ __name: "paper_positions", rows: [] }),
  },
}));

const { processPendingEventsForTest } = await import("./shadow.server");

const lease = { fence: 1, workerId: "ingest:test", lockId: "ingest:exp-1" };

const baseExperiment = {
  id: "exp-1",
  name: "CANDIDATE: BadTattoo",
  wallet_address: "0xa7011667f22c121c6cea7aab30192307c58c47cd",
  starting_cash: 380,
  cash: 380,
  buy_amount: 5,
  poll_interval_seconds: 60,
  enabled: true,
  weather_only: false,
  realized_pnl: 0,
  follow_from_ts: 1_000,
};

function event(overrides: Record<string, unknown>) {
  return {
    id: "evt-1",
    event_key: "key-1",
    asset: "asset-1",
    market_title: "Will ETH reach $5,000?",
    outcome: "Yes",
    side: "BUY",
    shares: 10,
    price: 0.4,
    source_ts: 2_000,
    first_seen_at: new Date().toISOString(),
    ...overrides,
  };
}

describe("market_scope processing semantics", () => {
  it("consumes a post-follow out-of-scope event without any paper accounting", async () => {
    commits.length = 0;
    pendingRows = [event({ market_title: "Highest temperature in Paris on August 20?" })];

    const result = await processPendingEventsForTest(
      { ...baseExperiment, market_scope: "CRYPTO" },
      lease,
    );

    expect(result).toEqual({
      processed: 1,
      buys: 0,
      sells: 0,
      skips: 0,
      backfilled: 0,
      scopeExcluded: 1,
    });
    expect(commits).toHaveLength(1);
    const commit = commits[0] as Record<string, unknown>;
    expect(commit["trade"]).toBeNull();
    expect(commit["paper_position"]).toBeNull();
    expect(commit["experiment"]).toBeNull();
    expect(commit["audit"]).toBeNull();
    // Source position state still advances so proportional sells stay truthful.
    expect(commit["source_state"]).toBeTruthy();
    expect(commit["backfilled"]).toBe(false);
  });

  it("follows normal BUY decision logic for a post-follow in-scope crypto event", async () => {
    commits.length = 0;
    pendingRows = [event({})];

    const result = await processPendingEventsForTest(
      { ...baseExperiment, market_scope: "CRYPTO" },
      lease,
    );

    expect(result.buys).toBe(1);
    expect(result.scopeExcluded).toBe(0);
    const commit = commits[0] as Record<string, unknown>;
    expect(commit["trade"]).toBeTruthy();
    expect(commit["experiment"]).toBeTruthy();
  });

  it("keeps ALL-scope behaviour unchanged for a non-crypto market", async () => {
    commits.length = 0;
    pendingRows = [event({ market_title: "Highest temperature in Paris on August 20?" })];

    const legacy = await processPendingEventsForTest({ ...baseExperiment }, lease);
    const explicitAll = { ...baseExperiment, market_scope: "ALL" };
    commits.length = 0;
    const scoped = await processPendingEventsForTest(explicitAll, lease);

    expect(legacy).toEqual(scoped);
    expect(scoped.buys).toBe(1);
    expect(scoped.scopeExcluded).toBe(0);
  });

  it("backfills pre-follow events without spending cash regardless of scope", async () => {
    commits.length = 0;
    pendingRows = [event({ source_ts: 500, market_title: "Will ETH reach $5,000?" })];

    const result = await processPendingEventsForTest(
      { ...baseExperiment, market_scope: "CRYPTO" },
      lease,
    );

    expect(result.backfilled).toBe(1);
    expect(result.buys).toBe(0);
    expect(result.scopeExcluded).toBe(0);
    const commit = commits[0] as Record<string, unknown>;
    expect(commit["backfilled"]).toBe(true);
    expect(commit["trade"]).toBeNull();
    expect(commit["experiment"]).toBeNull();
  });
});
