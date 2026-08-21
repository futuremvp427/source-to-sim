import { describe, expect, it, vi } from "vitest";

import type { OpenEpisodeState } from "./episode";
import {
  MAX_PAGES_PER_WALLET,
  pollSportsShadowWallet,
  type EpisodeCacheEntry,
  type NewSignalRow,
  type PendingDownstreamFillRow,
  type PollRepository,
  type RawFillRow,
  type SourcePollNetworkDeps,
  type WalletPollDeps,
} from "./source-poll.server";
import type { SourceMarketMetadata } from "./types";

const WALLET = "0xa71093cafc0c099b4ccab24c3cb8018d817923c4";
const PAGE_SIZE = 250;

type DownstreamStatus = "PENDING" | "COMPLETE" | "TERMINAL_INELIGIBLE" | "TERMINAL_INVALID";

/* ------------------------------------------------------------------ */
/* In-memory fake repository — mirrors the real Supabase semantics,     */
/* including Task 12D/P1-A's atomic episode-mutation + fill-completion  */
/* pairing: insertEpisodeAtomic/updateEpisodeAtomic either apply BOTH   */
/* their episode-side and fill-side effects, or (when configured to     */
/* throw) apply NEITHER -- the throw check runs before any mutation,    */
/* exactly mirroring a real Postgres transaction rollback.              */
/* ------------------------------------------------------------------ */

class FakeRepo implements PollRepository {
  fillsByEventKey = new Map<string, { id: string; row: RawFillRow; downstreamStatus: DownstreamStatus }>();
  fillsById = new Map<string, { id: string; row: RawFillRow; downstreamStatus: DownstreamStatus }>();
  episodesById = new Map<string, { row: NewSignalRow; state: OpenEpisodeState }>();
  nextId = 1;
  findLatestEpisodeCalls = 0;
  updateEpisodeAtomicCalls: Array<{ fillId: string; signalId: string; state: OpenEpisodeState }> = [];
  markFillCompleteCalls: string[] = [];
  markFillTerminalCalls: Array<{ fillId: string; status: string }> = [];
  throwOnHasAny: Error | null = null;
  throwOnFindExisting: Error | null = null;
  throwOnInsertRawFillFor: string | null = null;
  throwOnInsertEpisodeAtomic: Error | null = null;
  throwOnUpdateEpisodeAtomic: Error | null = null;
  throwOnCountDurableOrdinal: Error | null = null;
  throwOnFindPendingDownstreamFills: Error | null = null;

  async hasAnyFillsForWallet(wallet: string): Promise<boolean> {
    if (this.throwOnHasAny) throw this.throwOnHasAny;
    for (const { row } of this.fillsByEventKey.values()) {
      if (row.wallet === wallet) return true;
    }
    return false;
  }

  async findExistingEventKeys(wallet: string, eventKeys: string[]): Promise<Set<string>> {
    if (this.throwOnFindExisting) throw this.throwOnFindExisting;
    const out = new Set<string>();
    for (const key of eventKeys) {
      const existing = this.fillsByEventKey.get(key);
      if (existing && existing.row.wallet === wallet) out.add(key);
    }
    return out;
  }

  async insertRawFill(row: RawFillRow) {
    if (this.throwOnInsertRawFillFor === row.eventKey) throw new Error("simulated insertRawFill failure");
    const existing = this.fillsByEventKey.get(row.eventKey);
    if (existing) return { id: existing.id, inserted: false };
    const id = `fill-${this.nextId++}`;
    const entry = { id, row, downstreamStatus: "PENDING" as DownstreamStatus };
    this.fillsByEventKey.set(row.eventKey, entry);
    this.fillsById.set(id, entry);
    return { id, inserted: true };
  }

  async countDurableOrdinalFills(wallet: string, tuplePrefixes: string[]): Promise<Map<string, number>> {
    if (this.throwOnCountDurableOrdinal) throw this.throwOnCountDurableOrdinal;
    const out = new Map<string, number>();
    for (const prefix of tuplePrefixes) {
      let count = 0;
      for (const { row } of this.fillsByEventKey.values()) {
        if (row.wallet === wallet && row.eventKey.startsWith(prefix)) count += 1;
      }
      out.set(prefix, count);
    }
    return out;
  }

  async findLatestEpisode(wallet: string, conditionId: string, asset: string): Promise<EpisodeCacheEntry | null> {
    this.findLatestEpisodeCalls += 1;
    let best: { id: string; state: OpenEpisodeState } | null = null;
    for (const [id, entry] of this.episodesById) {
      if (entry.state.wallet !== wallet || entry.state.conditionId !== conditionId || entry.state.asset !== asset) continue;
      if (!best || entry.state.lastFillAt > best.state.lastFillAt) best = { id, state: entry.state };
    }
    return best;
  }

  async findPendingDownstreamFills(wallet: string, limit: number): Promise<PendingDownstreamFillRow[]> {
    if (this.throwOnFindPendingDownstreamFills) throw this.throwOnFindPendingDownstreamFills;
    const pending = [...this.fillsByEventKey.values()]
      .filter((f) => f.row.wallet === wallet && f.downstreamStatus === "PENDING")
      .sort((a, b) => a.row.sourceTs - b.row.sourceTs || a.row.eventKey.localeCompare(b.row.eventKey))
      .slice(0, limit);
    return pending.map((f) => ({
      id: f.id,
      eventKey: f.row.eventKey,
      walletHandle: f.row.walletHandle,
      conditionId: f.row.conditionId,
      asset: f.row.asset,
      outcome: f.row.outcome,
      eventSlug: f.row.eventSlug,
      marketSlug: f.row.marketSlug,
      side: f.row.side,
      shares: f.row.shares,
      price: f.row.price,
      sourceTs: f.row.sourceTs,
    }));
  }

  /** Atomic: throws BEFORE any mutation (matching a real rolled-back transaction), so a configured failure leaves the fill PENDING and no episode row created. */
  async insertEpisodeAtomic(fillId: string, row: NewSignalRow): Promise<{ id: string }> {
    if (this.throwOnInsertEpisodeAtomic) throw this.throwOnInsertEpisodeAtomic;
    const anchorFill = this.fillsById.get(fillId);
    const id = `signal-${this.nextId++}`;
    const state: OpenEpisodeState = {
      episodeKey: row.episodeKey,
      anchorEventKey: anchorFill?.row.eventKey ?? fillId,
      wallet: row.wallet,
      conditionId: row.conditionId,
      asset: row.asset,
      firstBuyAt: Math.floor(new Date(row.firstFillAtIso).getTime() / 1000),
      lastFillAt: Math.floor(new Date(row.lastFillAtIso).getTime() / 1000),
      vwap: row.vwap,
      totalShares: row.shares,
      totalNotional: row.notional,
      buyFillCount: row.fillCount,
      sellSeen: row.sellSeen,
      firstSellAt: null,
      lastSellAt: null,
      sellCount: 0,
      triggered: true,
      processedEventKeys: new Set([row.episodeKey]),
    };
    this.episodesById.set(id, { row, state });
    if (anchorFill) anchorFill.downstreamStatus = "COMPLETE";
    return { id };
  }

  /** Atomic: throws BEFORE any mutation, so a configured failure leaves BOTH the episode state AND the fill's downstream_status unchanged (still PENDING) -- see the Hard Design Gate tests below. */
  async updateEpisodeAtomic(fillId: string, signalId: string, state: OpenEpisodeState): Promise<void> {
    if (this.throwOnUpdateEpisodeAtomic) throw this.throwOnUpdateEpisodeAtomic;
    this.updateEpisodeAtomicCalls.push({ fillId, signalId, state });
    const existing = this.episodesById.get(signalId);
    if (existing) existing.state = state;
    const fill = this.fillsById.get(fillId);
    if (fill) fill.downstreamStatus = "COMPLETE";
  }

  async markFillComplete(fillId: string): Promise<void> {
    this.markFillCompleteCalls.push(fillId);
    const fill = this.fillsById.get(fillId);
    if (fill) fill.downstreamStatus = "COMPLETE";
  }

  async markFillTerminal(fillId: string, status: "TERMINAL_INELIGIBLE" | "TERMINAL_INVALID"): Promise<void> {
    this.markFillTerminalCalls.push({ fillId, status });
    const fill = this.fillsById.get(fillId);
    if (fill) fill.downstreamStatus = status;
  }
}

/* ------------------------------------------------------------------ */
/* Fixtures                                                             */
/* ------------------------------------------------------------------ */

function trade(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: `native-${Math.random().toString(36).slice(2)}`,
    proxyWallet: WALLET,
    side: "BUY",
    asset: "0xasset-moneyline-yankees",
    conditionId: "0xcondition-1",
    size: 10,
    price: 0.55,
    timestamp: 1_700_000_000,
    title: "Yankees vs Red Sox",
    slug: "yankees-moneyline",
    eventSlug: "yankees-vs-red-sox-2026-08-19",
    outcome: "Yankees",
    outcomeIndex: 0,
    name: "Talvez10",
    transactionHash: `0xtx-${Math.random().toString(36).slice(2)}`,
    ...overrides,
  };
}

const ELIGIBLE_METADATA: SourceMarketMetadata = {
  conditionId: "0xcondition-1",
  league: "MLB",
  sportsMarketType: "moneyline",
  betType: "MONEYLINE",
  status: "ELIGIBLE",
  reasonCode: "ELIGIBLE_FULL_GAME_MONEYLINE",
  ineligibleReason: null,
  line: null,
  awayTeam: "Yankees",
  homeTeam: "Red Sox",
  gameStartTime: "2026-08-19T23:00:00.000Z",
  sourceGameId: "game-1",
  eventSlug: "yankees-vs-red-sox-2026-08-19",
  marketSlug: "yankees-moneyline",
};

function makeNetworkDeps(pages: Record<number, unknown> | ((offset: number) => unknown)): SourcePollNetworkDeps {
  return {
    fetchImpl: (async (url: string | URL) => {
      const u = new URL(String(url));
      const offset = Number(u.searchParams.get("offset"));
      const body = typeof pages === "function" ? pages(offset) : pages[offset];
      if (body instanceof Error) throw body;
      return new Response(JSON.stringify(body ?? []), { status: 200, headers: { "content-type": "application/json" } });
    }) as typeof fetch,
    reserveRequestSlot: async () => 0,
    getHostCooldown: async () => ({ blocked: false, reason: null }),
    recordHostRateLimit: async () => {},
  };
}

function makeDeps(overrides: Partial<WalletPollDeps> = {}): { repo: FakeRepo; deps: Partial<WalletPollDeps> } {
  const repo = overrides.repo instanceof FakeRepo ? overrides.repo : new FakeRepo();
  return {
    repo,
    deps: {
      repo,
      now: () => 1_700_000_500_000,
      fetchSourceMarketMetadata: vi.fn(async () => ELIGIBLE_METADATA) as unknown as WalletPollDeps["fetchSourceMarketMetadata"],
      ...overrides,
    },
  };
}

/* ------------------------------------------------------------------ */

describe("pollSportsShadowWallet — bootstrap vs resumption detection", () => {
  it("reports isBootstrap=true when the wallet has no prior durable fills", async () => {
    const { deps } = makeDeps({ network: makeNetworkDeps({ 0: [] }) });
    const result = await pollSportsShadowWallet(WALLET, null, deps);
    expect(result.isBootstrap).toBe(true);
    expect(result.error).toBeNull();
  });

  it("reports isBootstrap=false when the wallet already has durable history", async () => {
    const repo = new FakeRepo();
    repo.fillsByEventKey.set("sid:existing", { id: "fill-existing", row: { eventKey: "sid:existing", wallet: WALLET.toLowerCase() } as RawFillRow, downstreamStatus: "COMPLETE" });
    const { deps } = makeDeps({ repo, network: makeNetworkDeps({ 0: [] }) });
    const result = await pollSportsShadowWallet(WALLET, null, deps);
    expect(result.isBootstrap).toBe(false);
  });

  it("normalizes the wallet address to lowercase for every downstream call", async () => {
    const repo = new FakeRepo();
    const { deps } = makeDeps({ repo, network: makeNetworkDeps({ 0: [trade({ transactionHash: "0xTX1" })] }) });
    const result = await pollSportsShadowWallet(WALLET.toUpperCase(), 0, deps);
    expect(result.wallet).toBe(WALLET.toLowerCase());
    expect([...repo.fillsByEventKey.values()][0]?.row.wallet).toBe(WALLET.toLowerCase());
  });
});

describe("pollSportsShadowWallet — pagination", () => {
  it("stops after one short page (fewer rows than PAGE_SIZE)", async () => {
    const { deps } = makeDeps({ network: makeNetworkDeps({ 0: [trade()] }) });
    const result = await pollSportsShadowWallet(WALLET, 0, deps);
    expect(result.pagesFetched).toBe(1);
    expect(result.rowsFetched).toBe(1);
  });

  it("stops immediately on an empty first page", async () => {
    const { deps } = makeDeps({ network: makeNetworkDeps({ 0: [] }) });
    const result = await pollSportsShadowWallet(WALLET, 0, deps);
    expect(result.pagesFetched).toBe(1);
    expect(result.rowsFetched).toBe(0);
  });

  it("stops pagination early once a page overlaps durable history", async () => {
    const repo = new FakeRepo();
    const overlapTrade = trade({ transactionHash: "0xoverlap", id: "sid-overlap" });
    // Pre-seed as if already durably known.
    repo.fillsByEventKey.set("sid:sid-overlap", { id: "fill-x", row: { eventKey: "sid:sid-overlap", wallet: WALLET.toLowerCase() } as RawFillRow, downstreamStatus: "COMPLETE" });

    const fullPage = Array.from({ length: PAGE_SIZE }, (_, i) => trade({ id: `native-page0-${i}`, transactionHash: `0xtx-page0-${i}` }));
    const { deps } = makeDeps({
      repo,
      network: makeNetworkDeps({ 0: fullPage, [PAGE_SIZE]: [overlapTrade] }),
    });
    const result = await pollSportsShadowWallet(WALLET, 0, deps);
    expect(result.pagesFetched).toBe(2);
    expect(result.backlogTruncated).toBe(false);
  });

  // Shared across both MAX_PAGES tests below: every offset returns the SAME 250-row page
  // (identical ids/tx hashes). This is deliberate and memory-light — the per-page overlap
  // check only inspects that single page's own keys against the repo (never accumulated
  // across pages), so reusing one array reference for all 41 offsets exercises the exact
  // same "page is full, no overlap this page" boundary condition as truly distinct pages
  // would, without allocating 10,000+ unique fixture objects on this sandbox's 2.7GB budget.
  const SHARED_FULL_PAGE = Array.from({ length: PAGE_SIZE }, (_, i) => trade({ id: `native-shared-${i}`, transactionHash: `0xtx-shared-${i}` }));

  it("marks backlogTruncated=true when a RESUMPTION poll exhausts MAX_PAGES_PER_WALLET without finding overlap", async () => {
    const repo = new FakeRepo();
    repo.fillsByEventKey.set("sid:preexisting", { id: "fill-pre", row: { eventKey: "sid:preexisting", wallet: WALLET.toLowerCase() } as RawFillRow, downstreamStatus: "COMPLETE" });
    const { deps } = makeDeps({ repo, network: makeNetworkDeps(() => SHARED_FULL_PAGE) });
    const result = await pollSportsShadowWallet(WALLET, 0, deps);
    expect(result.pagesFetched).toBe(MAX_PAGES_PER_WALLET);
    expect(result.backlogTruncated).toBe(true);
  });

  it("does NOT mark backlogTruncated for a genuine first-ever bootstrap that hits MAX_PAGES_PER_WALLET", async () => {
    const { deps } = makeDeps({ network: makeNetworkDeps(() => SHARED_FULL_PAGE) });
    const result = await pollSportsShadowWallet(WALLET, 0, deps);
    expect(result.isBootstrap).toBe(true);
    expect(result.backlogTruncated).toBe(false);
  });

  it("preserves partial progress when a mid-pagination fetch throws", async () => {
    const fullPage = Array.from({ length: PAGE_SIZE }, (_, i) => trade({ id: `native-0-${i}`, transactionHash: `0xtx-0-${i}` }));
    const { deps } = makeDeps({
      network: makeNetworkDeps((offset) => (offset === 0 ? fullPage : new Error("network down"))),
    });
    const result = await pollSportsShadowWallet(WALLET, 0, deps);
    expect(result.pagesFetched).toBe(1);
    expect(result.rowsFetched).toBe(PAGE_SIZE);
    expect(result.error).toContain("trade page fetch failed");
    // Rows from the successful first page were still processed despite the later failure.
    expect(result.newRows).toBeGreaterThan(0);
  });
});

describe("pollSportsShadowWallet — normalization edge cases", () => {
  it("silently drops a row with an unrecognized side (fail-closed in normalizeSourceEvents, not counted anywhere)", async () => {
    const { deps } = makeDeps({ network: makeNetworkDeps({ 0: [trade({ side: "WEIRD" })] }) });
    const result = await pollSportsShadowWallet(WALLET, 0, deps);
    expect(result.rowsFetched).toBe(1);
    expect(result.newRows).toBe(0);
    expect(result.invalidRows).toBe(0);
    expect(result.duplicateRows).toBe(0);
  });

  it("persists a fill lacking conditionId as durable evidence, marks unverified, marks the fill TERMINAL_INELIGIBLE (can never resolve), never calls metadata", async () => {
    const fetchSourceMarketMetadata = vi.fn(async () => ELIGIBLE_METADATA);
    const { repo, deps } = makeDeps({
      network: makeNetworkDeps({ 0: [trade({ conditionId: undefined })] }),
      fetchSourceMarketMetadata: fetchSourceMarketMetadata as unknown as WalletPollDeps["fetchSourceMarketMetadata"],
    });
    const result = await pollSportsShadowWallet(WALLET, 0, deps);
    expect(result.newRows).toBe(1);
    expect(result.unverifiedRows).toBe(1);
    expect(fetchSourceMarketMetadata).not.toHaveBeenCalled();
    expect(repo.fillsByEventKey.size).toBe(1);
    expect([...repo.fillsByEventKey.values()][0]?.downstreamStatus).toBe("TERMINAL_INELIGIBLE");
  });
});

describe("pollSportsShadowWallet — eligibility routing", () => {
  it("routes INELIGIBLE metadata to ineligibleRows, marks the fill TERMINAL_INELIGIBLE, and never touches the episode engine", async () => {
    const repo = new FakeRepo();
    const ineligible: SourceMarketMetadata = { ...ELIGIBLE_METADATA, status: "INELIGIBLE", betType: null, reasonCode: "REJECT_PROP" };
    const { deps } = makeDeps({
      repo,
      network: makeNetworkDeps({ 0: [trade()] }),
      fetchSourceMarketMetadata: vi.fn(async () => ineligible) as unknown as WalletPollDeps["fetchSourceMarketMetadata"],
    });
    const result = await pollSportsShadowWallet(WALLET, 0, deps);
    expect(result.ineligibleRows).toBe(1);
    expect(result.newSignals).toHaveLength(0);
    expect(repo.findLatestEpisodeCalls).toBe(0);
    expect([...repo.fillsByEventKey.values()][0]?.downstreamStatus).toBe("TERMINAL_INELIGIBLE");
  });

  it("routes UNVERIFIED metadata to unverifiedRows and leaves the fill PENDING (retried next poll, never treated as permanently processed)", async () => {
    const repo = new FakeRepo();
    const unverified: SourceMarketMetadata = { ...ELIGIBLE_METADATA, status: "UNVERIFIED", betType: null, reasonCode: "UNVERIFIED_METADATA_MISSING" };
    const { deps } = makeDeps({
      repo,
      network: makeNetworkDeps({ 0: [trade()] }),
      fetchSourceMarketMetadata: vi.fn(async () => unverified) as unknown as WalletPollDeps["fetchSourceMarketMetadata"],
    });
    const result = await pollSportsShadowWallet(WALLET, 0, deps);
    expect(result.unverifiedRows).toBe(1);
    expect([...repo.fillsByEventKey.values()][0]?.downstreamStatus).toBe("PENDING");
  });

  it("fails closed to unverifiedRows when status is ELIGIBLE but betType is unexpectedly null", async () => {
    const malformed: SourceMarketMetadata = { ...ELIGIBLE_METADATA, betType: null };
    const { deps } = makeDeps({
      network: makeNetworkDeps({ 0: [trade()] }),
      fetchSourceMarketMetadata: vi.fn(async () => malformed) as unknown as WalletPollDeps["fetchSourceMarketMetadata"],
    });
    const result = await pollSportsShadowWallet(WALLET, 0, deps);
    expect(result.unverifiedRows).toBe(1);
    expect(result.newSignals).toHaveLength(0);
  });

  it("counts a thrown metadata fetch as metadataFetchFailures, not ineligible/unverified, and leaves the fill PENDING", async () => {
    const repo = new FakeRepo();
    const { deps } = makeDeps({
      repo,
      network: makeNetworkDeps({ 0: [trade()] }),
      fetchSourceMarketMetadata: vi.fn(async () => {
        throw new Error("gamma-api unreachable");
      }) as unknown as WalletPollDeps["fetchSourceMarketMetadata"],
    });
    const result = await pollSportsShadowWallet(WALLET, 0, deps);
    expect(result.metadataFetchFailures).toBe(1);
    expect(result.error).toContain("gamma-api unreachable");
    expect([...repo.fillsByEventKey.values()][0]?.downstreamStatus).toBe("PENDING");
  });

  it("caches metadata by conditionId — two fills sharing a conditionId only fetch metadata once", async () => {
    const fetchSourceMarketMetadata = vi.fn(async () => ELIGIBLE_METADATA);
    const { deps } = makeDeps({
      network: makeNetworkDeps({
        0: [
          trade({ transactionHash: "0xtx-a", asset: "0xasset-away" }),
          trade({ transactionHash: "0xtx-b", asset: "0xasset-away", timestamp: 1_700_000_100 }),
        ],
      }),
      fetchSourceMarketMetadata: fetchSourceMarketMetadata as unknown as WalletPollDeps["fetchSourceMarketMetadata"],
    });
    await pollSportsShadowWallet(WALLET, 0, deps);
    expect(fetchSourceMarketMetadata).toHaveBeenCalledTimes(1);
  });
});

describe("pollSportsShadowWallet — bootstrap go-live gating", () => {
  it("suppresses episode triggering for a pre-go-live fill during bootstrap, still persists the raw fill, marks it COMPLETE (correct final answer, never re-triggered on a later resumption poll)", async () => {
    const repo = new FakeRepo();
    const { deps } = makeDeps({ repo, network: makeNetworkDeps({ 0: [trade({ timestamp: 1_700_000_000 })] }) });
    const goLiveAtMs = 1_700_000_000_000 + 3_600_000; // one hour after this fill
    const result = await pollSportsShadowWallet(WALLET, goLiveAtMs, deps);
    expect(result.suppressedPreGoLive).toBe(1);
    expect(result.newSignals).toHaveLength(0);
    expect(repo.findLatestEpisodeCalls).toBe(0);
    expect(repo.fillsByEventKey.size).toBe(1); // evidence still persisted
    expect([...repo.fillsByEventKey.values()][0]?.downstreamStatus).toBe("COMPLETE");
  });

  it("allows episode triggering for a post-go-live fill during bootstrap", async () => {
    const { deps } = makeDeps({ network: makeNetworkDeps({ 0: [trade({ timestamp: 1_700_000_000 })] }) });
    const goLiveAtMs = 1_700_000_000_000 - 1000; // one second before this fill
    const result = await pollSportsShadowWallet(WALLET, goLiveAtMs, deps);
    expect(result.suppressedPreGoLive).toBe(0);
    expect(result.newSignals).toHaveLength(1);
  });

  it("allows a genuinely post-go-live fill discovered during a RESUMPTION poll (unchanged from before)", async () => {
    const repo = new FakeRepo();
    repo.fillsByEventKey.set("sid:seed", { id: "fill-seed", row: { eventKey: "sid:seed", wallet: WALLET.toLowerCase() } as RawFillRow, downstreamStatus: "COMPLETE" });
    const { deps } = makeDeps({ repo, network: makeNetworkDeps({ 0: [trade({ timestamp: 1_700_000_000 })] }) });
    const goLiveAtMs = 1_700_000_000_000 - 1000; // one second before this fill: genuinely post-go-live
    const result = await pollSportsShadowWallet(WALLET, goLiveAtMs, deps);
    expect(result.isBootstrap).toBe(false);
    expect(result.suppressedPreGoLive).toBe(0);
    expect(result.newSignals).toHaveLength(1);
  });

  /**
   * Task 12E / P1-F: HARD REQUIREMENT proof, exercised through the ACTUAL Task 12D
   * durable-retry path (a real PENDING fill row, real findPendingDownstreamFills
   * re-query, real isBootstrap recomputed fresh from hasAnyFillsForWallet) -- not just
   * the pure isEligibleForEpisodeTrigger unit tests in source-poll.test.ts.
   *
   * Reproduces the exact defect scenario: a fill's sourceTs is BEFORE goLiveAtMs during
   * a wallet's bootstrap poll, but markFillComplete fails (simulating any transient
   * failure -- network blip, DB hiccup), so the fill stays PENDING instead of being
   * marked COMPLETE. Some other durable fill for the same wallet already exists, so on
   * the NEXT poll hasAnyFillsForWallet returns true and isBootstrap flips to false. Under
   * the pre-fix code (`if (!isBootstrap) return true`), this second poll would have
   * wrongly let the stale pre-go-live fill trigger a new episode. Under the fix, the
   * fill's OWN immutable sourceTs is still before the fixed goLiveAtMs, so it must be
   * suppressed again, identically.
   */
  it("HARD REQUIREMENT: a pre-go-live fill left PENDING (markFillComplete failed) is STILL suppressed on a later resumption-mode retry", async () => {
    const repo = new FakeRepo();
    // Unrelated durable history for this wallet, so the SECOND poll below sees isBootstrap=false.
    repo.fillsByEventKey.set("sid:unrelated-history", {
      id: "fill-unrelated",
      row: { eventKey: "sid:unrelated-history", wallet: WALLET.toLowerCase() } as RawFillRow,
      downstreamStatus: "COMPLETE",
    });
    const goLiveAtMs = 1_700_000_000_000 + 3_600_000; // one hour after the pre-go-live fill below
    const preGoLiveTrade = trade({ timestamp: 1_700_000_000, id: "pre-go-live-fill" });

    // First poll: markFillComplete fails, so the correctly-suppressed fill stays PENDING
    // instead of becoming the normal terminal COMPLETE.
    const { deps: firstDeps } = makeDeps({ repo, network: makeNetworkDeps({ 0: [preGoLiveTrade] }) });
    repo.markFillComplete = async (fillId: string) => {
      repo.markFillCompleteCalls.push(fillId);
      throw new Error("simulated transient markFillComplete failure");
    };
    const firstResult = await pollSportsShadowWallet(WALLET, goLiveAtMs, firstDeps);
    expect(firstResult.isBootstrap).toBe(false); // unrelated-history fill already made this a resumption poll
    expect(firstResult.suppressedPreGoLive).toBe(1);
    expect([...repo.fillsByEventKey.values()].find((f) => f.row.eventKey.includes("pre-go-live-fill"))?.downstreamStatus).toBe("PENDING");

    // Restore a working markFillComplete and poll again with an EMPTY page (nothing new to
    // fetch) -- the only thing this second poll has to do is retry the durably-PENDING fill.
    repo.markFillComplete = async (fillId: string) => {
      repo.markFillCompleteCalls.push(fillId);
      const entry = repo.fillsById.get(fillId);
      if (entry) entry.downstreamStatus = "COMPLETE";
    };
    const { deps: secondDeps } = makeDeps({ repo, network: makeNetworkDeps({ 0: [] }) });
    const secondResult = await pollSportsShadowWallet(WALLET, goLiveAtMs, secondDeps);
    expect(secondResult.isBootstrap).toBe(false); // resumption mode, exactly the condition the old bug required
    expect(secondResult.suppressedPreGoLive).toBe(1); // still suppressed -- NOT wrongly promoted to eligible
    expect(secondResult.newSignals).toHaveLength(0);
    expect(repo.findLatestEpisodeCalls).toBe(0); // never even reached the episode engine
    expect([...repo.fillsByEventKey.values()].find((f) => f.row.eventKey.includes("pre-go-live-fill"))?.downstreamStatus).toBe("COMPLETE");
  });
});

describe("pollSportsShadowWallet — episode engine integration", () => {
  it("creates a new signal row for a first BUY, with fields sourced from Task 3 metadata", async () => {
    const { deps } = makeDeps({ network: makeNetworkDeps({ 0: [trade()] }) });
    const result = await pollSportsShadowWallet(WALLET, 0, deps);
    expect(result.newSignals).toHaveLength(1);
    const signal = result.newSignals[0]!;
    expect(signal.betType).toBe("MONEYLINE");
    expect(signal.awayTeam).toBe("Yankees");
    expect(signal.homeTeam).toBe("Red Sox");
    expect(signal.selectedSide).toBe("Yankees");
    expect(signal.sourceEventSlug).toBe("yankees-vs-red-sox-2026-08-19");
    expect(signal.sourceMarketSlug).toBe("yankees-moneyline");
    expect(signal.vwap).toBeCloseTo(0.55);
  });

  it("falls back selectedSide to 'UNKNOWN' when the fill has no outcome", async () => {
    const { deps } = makeDeps({ network: makeNetworkDeps({ 0: [trade({ outcome: undefined })] }) });
    const result = await pollSportsShadowWallet(WALLET, 0, deps);
    expect(result.newSignals[0]?.selectedSide).toBe("UNKNOWN");
  });

  it("the anchor fill and every aggregated fill are marked COMPLETE after successful downstream processing", async () => {
    const repo = new FakeRepo();
    const { deps } = makeDeps({
      repo,
      network: makeNetworkDeps({
        0: [
          trade({ transactionHash: "0xtx-a", timestamp: 1_700_000_000, size: 10, price: 0.5 }),
          trade({ transactionHash: "0xtx-b", timestamp: 1_700_000_500, size: 10, price: 0.6 }),
        ],
      }),
    });
    await pollSportsShadowWallet(WALLET, 0, deps);
    expect([...repo.fillsByEventKey.values()].every((f) => f.downstreamStatus === "COMPLETE")).toBe(true);
  });

  it("aggregates a second same-position BUY within the 30-minute window (AGGREGATED_BUY)", async () => {
    const repo = new FakeRepo();
    const { deps } = makeDeps({
      repo,
      network: makeNetworkDeps({
        0: [
          trade({ transactionHash: "0xtx-a", timestamp: 1_700_000_000, size: 10, price: 0.5 }),
          trade({ transactionHash: "0xtx-b", timestamp: 1_700_000_500, size: 10, price: 0.6 }),
        ],
      }),
    });
    const result = await pollSportsShadowWallet(WALLET, 0, deps);
    expect(result.newSignals).toHaveLength(1);
    expect(result.aggregatedCount).toBe(1);
    const episode = [...repo.episodesById.values()][0]!;
    expect(episode.state.totalShares).toBe(20);
    expect(episode.state.vwap).toBeCloseTo((10 * 0.5 + 10 * 0.6) / 20);
  });

  it("starts a NEW_EPISODE_AFTER_30M for a same-position BUY beyond the aggregation window, without a second findLatestEpisode round trip", async () => {
    const repo = new FakeRepo();
    const { deps } = makeDeps({
      repo,
      network: makeNetworkDeps({
        0: [
          trade({ transactionHash: "0xtx-a", timestamp: 1_700_000_000 }),
          trade({ transactionHash: "0xtx-b", timestamp: 1_700_000_000 + 3601 }),
        ],
      }),
    });
    const result = await pollSportsShadowWallet(WALLET, 0, deps);
    expect(result.newSignals).toHaveLength(2);
    expect(repo.episodesById.size).toBe(2);
    // Position cache reused after the first lookup; the second fill never re-queries the DB.
    expect(repo.findLatestEpisodeCalls).toBe(1);
  });

  it("reuses the in-memory position cache across fills in one poll pass (single findLatestEpisode call)", async () => {
    const repo = new FakeRepo();
    const { deps } = makeDeps({
      repo,
      network: makeNetworkDeps({
        0: [
          trade({ transactionHash: "0xtx-a", timestamp: 1_700_000_000 }),
          trade({ transactionHash: "0xtx-b", timestamp: 1_700_000_100 }),
          trade({ transactionHash: "0xtx-c", timestamp: 1_700_000_200 }),
        ],
      }),
    });
    await pollSportsShadowWallet(WALLET, 0, deps);
    expect(repo.findLatestEpisodeCalls).toBe(1);
  });

  it("records a LATE_RECONCILIATION fill (sourceTs behind the episode's high-water mark) without moving lastFillAt backward", async () => {
    // A single poll pass can never observe LATE_RECONCILIATION: normalizeSourceEvents always
    // sorts ascending by sourceTs before decideFill ever sees anything, so an "earlier" row in
    // the raw payload is always processed FIRST within one pass. LATE_RECONCILIATION only
    // arises across two separate polls, once a fill genuinely behind an already-durable
    // high-water mark shows up later (e.g. a backfilled/delayed row from the source API).
    const repo = new FakeRepo();
    const { deps: firstDeps } = makeDeps({ repo, network: makeNetworkDeps({ 0: [trade({ transactionHash: "0xtx-a", timestamp: 1_700_000_500 })] }) });
    const first = await pollSportsShadowWallet(WALLET, 0, firstDeps);
    expect(first.newSignals).toHaveLength(1);

    const { deps: secondDeps } = makeDeps({ repo, network: makeNetworkDeps({ 0: [trade({ transactionHash: "0xtx-b", timestamp: 1_700_000_000 })] }) });
    const result = await pollSportsShadowWallet(WALLET, 0, secondDeps);
    expect(result.lateReconciliationCount).toBe(1);
    const episode = [...repo.episodesById.values()][0]!;
    expect(episode.state.lastFillAt).toBe(1_700_000_500);
    expect(episode.state.totalShares).toBe(20);
  });

  it("records SELL_RECORDED against a matching open position, marks source_sell_seen, and marks the SELL fill COMPLETE", async () => {
    const repo = new FakeRepo();
    const { deps } = makeDeps({
      repo,
      network: makeNetworkDeps({
        0: [
          trade({ transactionHash: "0xtx-a", side: "BUY", timestamp: 1_700_000_000 }),
          trade({ transactionHash: "0xtx-b", side: "SELL", timestamp: 1_700_000_100, size: 5 }),
        ],
      }),
    });
    const result = await pollSportsShadowWallet(WALLET, 0, deps);
    expect(result.sellRecordedCount).toBe(1);
    const episode = [...repo.episodesById.values()][0]!;
    expect(episode.state.sellSeen).toBe(true);
    expect(repo.updateEpisodeAtomicCalls.some((c) => c.state.sellSeen)).toBe(true);
    expect([...repo.fillsByEventKey.values()].every((f) => f.downstreamStatus === "COMPLETE")).toBe(true);
  });

  it("records SELL_RECORDED with no episode DB write when there is no matching open position, and marks the fill COMPLETE (nothing durable left to do)", async () => {
    const repo = new FakeRepo();
    const { deps } = makeDeps({ repo, network: makeNetworkDeps({ 0: [trade({ side: "SELL" })] }) });
    const result = await pollSportsShadowWallet(WALLET, 0, deps);
    expect(result.sellRecordedCount).toBe(1);
    expect(repo.updateEpisodeAtomicCalls).toHaveLength(0);
    expect(repo.episodesById.size).toBe(0);
    expect(repo.markFillCompleteCalls).toHaveLength(1);
    expect([...repo.fillsByEventKey.values()][0]?.downstreamStatus).toBe("COMPLETE");
  });

  it("counts an INVALID_FILL from decideFill (e.g. zero shares) without crashing the poll, and marks the fill TERMINAL_INVALID (its own immutable data will never validate)", async () => {
    const repo = new FakeRepo();
    const { deps } = makeDeps({ repo, network: makeNetworkDeps({ 0: [trade({ size: 0 })] }) });
    const result = await pollSportsShadowWallet(WALLET, 0, deps);
    expect(result.invalidRows).toBe(1);
    expect(result.newRows).toBe(1); // the raw fill is still persisted as evidence
    expect(result.newSignals).toHaveLength(0);
    expect([...repo.fillsByEventKey.values()][0]?.downstreamStatus).toBe("TERMINAL_INVALID");
  });

  it("defense-in-depth: a fill whose eventKey is already known durably is treated as duplicateRows and never reprocessed, whether or not decideFill's own processedEventKeys would also have caught it", async () => {
    const repo = new FakeRepo();
    const seedTrade = trade({ transactionHash: "0xtx-seed", timestamp: 1_700_000_000 });
    const { deps } = makeDeps({ repo, network: makeNetworkDeps({ 0: [seedTrade] }) });
    const first = await pollSportsShadowWallet(WALLET, 0, deps);
    expect(first.newSignals).toHaveLength(1);
    const anchorKey = [...repo.fillsByEventKey.keys()][0]!;

    // Second poll: same fill reappears (simulating an overlap-detection miss), and the fake's
    // findExistingEventKeys legitimately reports it as known this time, so it is filtered
    // before ever reaching decideFill or phase 2 at all — proving the primary DB pre-filter,
    // not decideFill, is what prevents reprocessing in the normal path. It is also already
    // COMPLETE from the first poll, so even findPendingDownstreamFills would not surface it
    // again either -- two independent, redundant safety nets.
    const second = await pollSportsShadowWallet(WALLET, 0, deps);
    expect(second.duplicateRows).toBeGreaterThan(0);
    expect(second.newSignals).toHaveLength(0);
    expect(anchorKey).toBeTruthy();
  });
});

describe("pollSportsShadowWallet — Task 12D/P1-A: durable downstream retry", () => {
  it("orphanedFillsRecovered reports 0 when every processed fill was inserted this same poll", async () => {
    const { deps } = makeDeps({ network: makeNetworkDeps({ 0: [trade()] }) });
    const result = await pollSportsShadowWallet(WALLET, 0, deps);
    expect(result.orphanedFillsRecovered).toBe(0);
  });

  it("a fill left PENDING by metadata failure on poll 1 is picked up and completed on poll 2, reported as orphanedFillsRecovered, without re-fetching it from the network", async () => {
    const repo = new FakeRepo();
    const failingMetadata = vi.fn(async () => {
      throw new Error("gamma-api unreachable");
    });
    const { deps: deps1 } = makeDeps({ repo, network: makeNetworkDeps({ 0: [trade({ transactionHash: "0xtx-orphan" })] }), fetchSourceMarketMetadata: failingMetadata as unknown as WalletPollDeps["fetchSourceMarketMetadata"] });
    const first = await pollSportsShadowWallet(WALLET, 0, deps1);
    expect(first.newRows).toBe(1);
    expect(first.metadataFetchFailures).toBe(1);
    expect(first.newSignals).toHaveLength(0);
    expect([...repo.fillsByEventKey.values()][0]?.downstreamStatus).toBe("PENDING");

    // Poll 2: network returns NOTHING new (the fill is already durable), but metadata now succeeds.
    const { deps: deps2 } = makeDeps({ repo, network: makeNetworkDeps({ 0: [] }) });
    const second = await pollSportsShadowWallet(WALLET, 0, deps2);
    expect(second.newRows).toBe(0); // nothing new fetched from the network
    expect(second.orphanedFillsRecovered).toBe(1); // but the orphaned PENDING fill WAS recovered
    expect(second.newSignals).toHaveLength(1); // and it now successfully produced a signal
    expect([...repo.fillsByEventKey.values()][0]?.downstreamStatus).toBe("COMPLETE");
  });

  it("fault injection: findLatestEpisode failure leaves the fill PENDING, retried and completed on the next poll", async () => {
    const repo = new FakeRepo();
    const originalFind = repo.findLatestEpisode.bind(repo);
    let calls = 0;
    repo.findLatestEpisode = async (wallet, conditionId, asset) => {
      calls += 1;
      if (calls === 1) throw new Error("findLatestEpisode transient failure");
      return originalFind(wallet, conditionId, asset);
    };
    const { deps: deps1 } = makeDeps({ repo, network: makeNetworkDeps({ 0: [trade({ transactionHash: "0xtx-a" })] }) });
    const first = await pollSportsShadowWallet(WALLET, 0, deps1);
    expect(first.error).toContain("findLatestEpisode transient failure");
    expect(first.newSignals).toHaveLength(0);
    expect([...repo.fillsByEventKey.values()][0]?.downstreamStatus).toBe("PENDING");

    const { deps: deps2 } = makeDeps({ repo, network: makeNetworkDeps({ 0: [] }) });
    const second = await pollSportsShadowWallet(WALLET, 0, deps2);
    expect(second.newSignals).toHaveLength(1);
    expect([...repo.fillsByEventKey.values()][0]?.downstreamStatus).toBe("COMPLETE");
  });

  it("fault injection: insertEpisodeAtomic (signal-insert) failure leaves the fill PENDING, no episode created, retried and completed on the next poll", async () => {
    const repo = new FakeRepo();
    repo.throwOnInsertEpisodeAtomic = new Error("unique_violation");
    const { deps: deps1 } = makeDeps({ repo, network: makeNetworkDeps({ 0: [trade({ transactionHash: "0xtx-a" })] }) });
    const first = await pollSportsShadowWallet(WALLET, 0, deps1);
    expect(first.error).toContain("unique_violation");
    expect(first.newSignals).toHaveLength(0);
    expect(repo.episodesById.size).toBe(0);
    expect([...repo.fillsByEventKey.values()][0]?.downstreamStatus).toBe("PENDING");

    repo.throwOnInsertEpisodeAtomic = null;
    const { deps: deps2 } = makeDeps({ repo, network: makeNetworkDeps({ 0: [] }) });
    const second = await pollSportsShadowWallet(WALLET, 0, deps2);
    expect(second.newSignals).toHaveLength(1);
    expect(repo.episodesById.size).toBe(1);
    expect([...repo.fillsByEventKey.values()][0]?.downstreamStatus).toBe("COMPLETE");
  });

  it("fault injection: updateEpisodeAtomic (episode-update) failure on an AGGREGATED_BUY leaves the SECOND fill PENDING and does NOT mutate the episode, retried and completed on the next poll", async () => {
    const repo = new FakeRepo();
    const { deps: seedDeps } = makeDeps({ repo, network: makeNetworkDeps({ 0: [trade({ transactionHash: "0xtx-a", timestamp: 1_700_000_000, size: 10, price: 0.5 })] }) });
    const seed = await pollSportsShadowWallet(WALLET, 0, seedDeps);
    expect(seed.newSignals).toHaveLength(1);
    const episodeStateBefore = { ...[...repo.episodesById.values()][0]!.state };

    repo.throwOnUpdateEpisodeAtomic = new Error("update failed");
    const { deps: deps2 } = makeDeps({ repo, network: makeNetworkDeps({ 0: [trade({ transactionHash: "0xtx-b", timestamp: 1_700_000_100, size: 10, price: 0.6 })] }) });
    const second = await pollSportsShadowWallet(WALLET, 0, deps2);
    expect(second.error).toContain("update failed");
    expect(second.aggregatedCount).toBe(1); // decision was still computed and counted even though the write failed
    // The episode state is UNCHANGED -- the throw happened before any mutation, matching a real rolled-back transaction.
    expect([...repo.episodesById.values()][0]!.state).toEqual(episodeStateBefore);
    const pendingCount = [...repo.fillsByEventKey.values()].filter((f) => f.downstreamStatus === "PENDING").length;
    expect(pendingCount).toBe(1); // exactly the second fill remains PENDING

    // Retry: the failure is cleared, the SAME fill is recovered and applied EXACTLY ONCE.
    repo.throwOnUpdateEpisodeAtomic = null;
    const { deps: deps3 } = makeDeps({ repo, network: makeNetworkDeps({ 0: [] }) });
    const third = await pollSportsShadowWallet(WALLET, 0, deps3);
    expect(third.orphanedFillsRecovered).toBe(1);
    expect(third.aggregatedCount).toBe(1);
    const finalEpisode = [...repo.episodesById.values()][0]!.state;
    // HARD DESIGN GATE PROOF: totalShares reflects the second fill's 10 shares applied
    // EXACTLY ONCE (10 + 10 = 20), never twice (which would be 30) despite the failed
    // first attempt having already computed (but never committed) the same aggregation.
    expect(finalEpisode.totalShares).toBe(20);
    expect(finalEpisode.vwap).toBeCloseTo((10 * 0.5 + 10 * 0.6) / 20);
    expect([...repo.fillsByEventKey.values()].every((f) => f.downstreamStatus === "COMPLETE")).toBe(true);
  });

  it("HARD DESIGN GATE: a fill whose atomic write throws mid-transaction is never double-applied even across three retries", async () => {
    const repo = new FakeRepo();
    const { deps: seedDeps } = makeDeps({ repo, network: makeNetworkDeps({ 0: [trade({ transactionHash: "0xtx-a", timestamp: 1_700_000_000, size: 10, price: 0.5 })] }) });
    await pollSportsShadowWallet(WALLET, 0, seedDeps);

    repo.throwOnUpdateEpisodeAtomic = new Error("simulated crash 1");
    const { deps: deps2 } = makeDeps({ repo, network: makeNetworkDeps({ 0: [trade({ transactionHash: "0xtx-b", timestamp: 1_700_000_100, size: 10, price: 0.6 })] }) });
    await pollSportsShadowWallet(WALLET, 0, deps2); // crashes, fill stays PENDING

    repo.throwOnUpdateEpisodeAtomic = new Error("simulated crash 2");
    const { deps: deps3 } = makeDeps({ repo, network: makeNetworkDeps({ 0: [] }) });
    await pollSportsShadowWallet(WALLET, 0, deps3); // retried, crashes AGAIN, still PENDING

    repo.throwOnUpdateEpisodeAtomic = null;
    const { deps: deps4 } = makeDeps({ repo, network: makeNetworkDeps({ 0: [] }) });
    const finalPoll = await pollSportsShadowWallet(WALLET, 0, deps4); // third retry finally succeeds

    expect(finalPoll.aggregatedCount).toBe(1);
    const finalEpisode = [...repo.episodesById.values()][0]!.state;
    expect(finalEpisode.totalShares).toBe(20); // still exactly once, not 3x, despite 2 prior crashes
    expect(finalEpisode.buyFillCount).toBe(2);
  });
});

describe("pollSportsShadowWallet — error handling", () => {
  it("returns immediately with an error when hasAnyFillsForWallet throws, making no further calls", async () => {
    const repo = new FakeRepo();
    repo.throwOnHasAny = new Error("db unreachable");
    const { deps } = makeDeps({ repo, network: makeNetworkDeps({ 0: [] }) });
    const result = await pollSportsShadowWallet(WALLET, 0, deps);
    expect(result.error).toContain("db unreachable");
    expect(result.pagesFetched).toBe(0);
  });

  it("falls back to treating everything as new when the final findExistingEventKeys call throws", async () => {
    const repo = new FakeRepo();
    const { deps } = makeDeps({ repo, network: makeNetworkDeps({ 0: [trade()] }) });
    // Flip the throw flag only after pagination's own per-page overlap check has already run once.
    const originalFind = repo.findExistingEventKeys.bind(repo);
    let calls = 0;
    repo.findExistingEventKeys = async (wallet: string, keys: string[]) => {
      calls += 1;
      if (calls === 2) throw new Error("final dedup query failed");
      return originalFind(wallet, keys);
    };
    const result = await pollSportsShadowWallet(WALLET, 0, deps);
    expect(result.error).toContain("final dedup query failed");
    expect(result.newRows).toBe(1);
  });

  it("continues processing subsequent fills after one insertRawFill failure", async () => {
    const repo = new FakeRepo();
    const badTx = "0xtx-bad";
    let calls = 0;
    const originalInsert = repo.insertRawFill.bind(repo);
    repo.insertRawFill = async (row: RawFillRow) => {
      calls += 1;
      if (calls === 1) throw new Error("insert failed");
      return originalInsert(row);
    };
    const { deps } = makeDeps({
      repo,
      network: makeNetworkDeps({
        0: [trade({ transactionHash: badTx, timestamp: 1_700_000_000 }), trade({ transactionHash: "0xtx-good", timestamp: 1_700_000_100 })],
      }),
    });
    const result = await pollSportsShadowWallet(WALLET, 0, deps);
    expect(result.invalidRows).toBe(1);
    expect(result.newRows).toBe(1);
    expect(result.error).toContain("insert failed");
  });

  it("a findPendingDownstreamFills failure is reported and phase 2 processes zero fills this poll (safe -- everything stays PENDING/durable, retried next poll)", async () => {
    const repo = new FakeRepo();
    repo.throwOnFindPendingDownstreamFills = new Error("db unreachable");
    const { deps } = makeDeps({ repo, network: makeNetworkDeps({ 0: [trade()] }) });
    const result = await pollSportsShadowWallet(WALLET, 0, deps);
    expect(result.error).toContain("db unreachable");
    expect(result.newRows).toBe(1); // phase 1 (raw insert) still succeeded
    expect(result.newSignals).toHaveLength(0); // phase 2 never ran
    expect([...repo.fillsByEventKey.values()][0]?.downstreamStatus).toBe("PENDING");
  });

  it("never throws out of pollSportsShadowWallet itself for any of the above failures", async () => {
    const repo = new FakeRepo();
    repo.throwOnHasAny = new Error("boom");
    const { deps } = makeDeps({ repo, network: makeNetworkDeps({ 0: [] }) });
    await expect(pollSportsShadowWallet(WALLET, 0, deps)).resolves.toBeDefined();
  });
});

describe("pollSportsShadowWallet — STABLE EVENT-KEY window-shift audit (degraded tx_hash_ordinal identity)", () => {
  const COLLIDE_TX = "0xcollide-shared-tx";
  const COLLIDE_ASSET = "0xasset-collide";
  const COLLIDE_TS = 1_700_050_000;
  const COLLIDE_TUPLE_PREFIX = `ord:${COLLIDE_TX}:${COLLIDE_ASSET}:BUY:${COLLIDE_TS}:10:0.5#`;

  function collidingRow(marker: string, overrides: Record<string, unknown> = {}) {
    return trade({
      id: undefined,
      transactionHash: COLLIDE_TX,
      asset: COLLIDE_ASSET,
      side: "BUY",
      timestamp: COLLIDE_TS,
      size: 10,
      price: 0.5,
      conditionId: "0xcondition-1",
      _marker: marker,
      ...overrides,
    });
  }

  function countDurableForTuple(repo: FakeRepo, wallet: string): number {
    let n = 0;
    for (const { row } of repo.fillsByEventKey.values()) {
      if (row.wallet === wallet && row.eventKey.startsWith(COLLIDE_TUPLE_PREFIX)) n += 1;
    }
    return n;
  }

  it("A. same two physical fills reconcile identically even when a later poll observes them in reversed array order", async () => {
    const repo = new FakeRepo();
    const rowX = collidingRow("X");
    const rowY = collidingRow("Y");

    const { deps: depsA } = makeDeps({ repo, network: makeNetworkDeps({ 0: [rowX, rowY] }) });
    const pollA = await pollSportsShadowWallet(WALLET, 0, depsA);
    expect(pollA.newRows).toBe(2);
    expect(countDurableForTuple(repo, WALLET.toLowerCase())).toBe(2);

    // Same two physical fills, array order reversed -- must reconcile as pure duplicates, not
    // swap identities, not double-insert, not drop, not re-trigger an episode.
    const { deps: depsB } = makeDeps({ repo, network: makeNetworkDeps({ 0: [rowY, rowX] }) });
    const pollB = await pollSportsShadowWallet(WALLET, 0, depsB);
    expect(pollB.newRows).toBe(0);
    expect(pollB.duplicateRows).toBeGreaterThanOrEqual(2);
    expect(pollB.newSignals).toHaveLength(0);
    expect(countDurableForTuple(repo, WALLET.toLowerCase())).toBe(2);
  });

  it("B. reconciles correctly when the colliding pair's page-boundary split differs between polls", async () => {
    const repo = new FakeRepo();
    const rowX = collidingRow("X");
    const rowY = collidingRow("Y");
    const filler = (n: number, prefix: string) =>
      Array.from({ length: n }, (_, i) => trade({ id: `filler-${prefix}-${i}`, transactionHash: `0xfiller-${prefix}-${i}`, conditionId: null }));

    // Poll A: rowX ends page0 (250 rows exactly), rowY alone starts+ends a short page1.
    const page0 = [...filler(249, "a"), rowX];
    const page1 = [rowY];
    const { deps: depsA } = makeDeps({ repo, network: makeNetworkDeps({ 0: page0, [PAGE_SIZE]: page1 }) });
    const pollA = await pollSportsShadowWallet(WALLET, 0, depsA);
    expect(pollA.pagesFetched).toBe(2);
    expect(countDurableForTuple(repo, WALLET.toLowerCase())).toBe(2);

    // Poll B: the boundary has "shifted" -- both physical fills now land together on one page.
    // Both are already durable; must reconcile as duplicates regardless of the new arrangement.
    const { deps: depsB } = makeDeps({ repo, network: makeNetworkDeps({ 0: [rowX, rowY] }) });
    const pollB = await pollSportsShadowWallet(WALLET, 0, depsB);
    expect(pollB.newRows).toBe(0);
    expect(countDurableForTuple(repo, WALLET.toLowerCase())).toBe(2);
  });

  it("C. a later poll observing only ONE of two already-durable colliding fills does not relabel it as a new '#0'", async () => {
    const repo = new FakeRepo();
    const { deps: depsA } = makeDeps({ repo, network: makeNetworkDeps({ 0: [collidingRow("X"), collidingRow("Y")] }) });
    await pollSportsShadowWallet(WALLET, 0, depsA);
    expect(countDurableForTuple(repo, WALLET.toLowerCase())).toBe(2);

    // Poll B's fetch window only reaches ONE occurrence of the tuple this time.
    const { deps: depsB } = makeDeps({ repo, network: makeNetworkDeps({ 0: [collidingRow("Z")] }) });
    const pollB = await pollSportsShadowWallet(WALLET, 0, depsB);
    expect(pollB.newRows).toBe(0);
    expect(pollB.duplicateRows).toBeGreaterThanOrEqual(1);
    // Still exactly 2 durable rows for this tuple -- NOT 3. A lone re-observed occurrence was
    // never blindly treated as a fresh "#0" and inserted as a false new physical fill.
    expect(countDurableForTuple(repo, WALLET.toLowerCase())).toBe(2);
  });

  it("D. pagination overlap-stop ignores a degraded-only key match and only trusts a reliable identity match", async () => {
    const repo = new FakeRepo();
    repo.fillsByEventKey.set("sid:seed-reliable", { id: "fill-seed-1", row: { eventKey: "sid:seed-reliable", wallet: WALLET.toLowerCase() } as RawFillRow, downstreamStatus: "COMPLETE" });
    const seedDegradedKey = `${COLLIDE_TUPLE_PREFIX}0`;
    repo.fillsByEventKey.set(seedDegradedKey, { id: "fill-seed-2", row: { eventKey: seedDegradedKey, wallet: WALLET.toLowerCase() } as RawFillRow, downstreamStatus: "COMPLETE" });

    const filler = (n: number, prefix: string) =>
      Array.from({ length: n }, (_, i) =>
        trade({ id: undefined, transactionHash: `0x${prefix}-${i}`, asset: `0xfiller-asset-${prefix}-${i}`, timestamp: 1_700_060_000 + i, conditionId: null }),
      );
    // page0: 249 unrelated degraded fillers + one row that page-locally recomputes to the SAME
    // ordinal-#0 string as the pre-seeded durable degraded key above (pure page-local coincidence,
    // unrelated physical fill) -- must NOT be trusted as proof pagination has reached known territory.
    const page0 = [...filler(249, "p0"), collidingRow("ALIAS")];
    // page1: a genuinely reliable, already-durable key -- THIS is what must stop pagination.
    const page1 = [trade({ id: "seed-reliable", transactionHash: "0xreliable-seed-tx" })];

    const { deps } = makeDeps({ repo, network: makeNetworkDeps({ 0: page0, [PAGE_SIZE]: page1 }) });
    const result = await pollSportsShadowWallet(WALLET, 0, deps);
    expect(result.pagesFetched).toBe(2); // did NOT stop after page0's degraded-only alias
    expect(result.backlogTruncated).toBe(false); // a genuine reliable overlap was eventually found
  });

  it("E. degraded reconciliation is deterministic across a fresh deps instance sharing only the durable repo (process restart)", async () => {
    const repo = new FakeRepo();
    const { deps: depsProcess1 } = makeDeps({ repo, network: makeNetworkDeps({ 0: [collidingRow("X"), collidingRow("Y")] }) });
    await pollSportsShadowWallet(WALLET, 0, depsProcess1);
    expect(countDurableForTuple(repo, WALLET.toLowerCase())).toBe(2);

    // A brand new deps object standing in for a fresh process: nothing is carried over except the
    // durable repo itself -- source-poll.server.ts holds no module-level mutable cache at all
    // (unlike e.g. kalshi.server.ts's discovery cache), so this is exactly what a real restart looks like.
    const depsProcess2: Partial<WalletPollDeps> = {
      repo,
      now: () => 1_700_100_000_000,
      fetchSourceMarketMetadata: vi.fn(async () => ELIGIBLE_METADATA) as unknown as WalletPollDeps["fetchSourceMarketMetadata"],
      network: makeNetworkDeps({ 0: [collidingRow("Z")] }),
    };
    const result = await pollSportsShadowWallet(WALLET, 0, depsProcess2);
    expect(result.newRows).toBe(0);
    expect(countDurableForTuple(repo, WALLET.toLowerCase())).toBe(2);
  });
});
