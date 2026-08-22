import { describe, expect, it, vi } from "vitest";

import { DATA_API_HOST, DeadlineExceededError } from "../http-rate-limit.server";
import type { UnverifiedReasonCode } from "./eligibility";
import type { OpenEpisodeState } from "./episode";
import {
  MAX_PAGES_PER_WALLET,
  MAX_PENDING_FILLS_PER_POLL,
  pollSportsShadowWallet,
  type EpisodeCacheEntry,
  type NewSignalRow,
  type PendingDownstreamFillRow,
  type PollRepository,
  type RawFillRow,
  type SourcePollNetworkDeps,
  type WalletPollDeps,
} from "./source-poll.server";
import { NO_OP_LEASE_CHECKPOINT, type LeaseCheckpoint } from "./sports-lease.server";
import type { SourceMarketMetadata } from "./types";

const WALLET = "0xa71093cafc0c099b4ccab24c3cb8018d817923c4";
const PAGE_SIZE = 250;

type DownstreamStatus = "PENDING" | "COMPLETE" | "TERMINAL_INELIGIBLE" | "TERMINAL_INVALID" | "TERMINAL_UNVERIFIED";

/* ------------------------------------------------------------------ */
/* In-memory fake repository — mirrors the real Supabase semantics,     */
/* including Task 12D/P1-A's atomic episode-mutation + fill-completion  */
/* pairing: insertEpisodeAtomic/updateEpisodeAtomic either apply BOTH   */
/* their episode-side and fill-side effects, or (when configured to     */
/* throw) apply NEITHER -- the throw check runs before any mutation,    */
/* exactly mirroring a real Postgres transaction rollback.              */
/* ------------------------------------------------------------------ */

class FakeRepo implements PollRepository {
  fillsByEventKey = new Map<string, { id: string; row: RawFillRow; downstreamStatus: DownstreamStatus; unverifiedReason?: string }>();
  fillsById = new Map<string, { id: string; row: RawFillRow; downstreamStatus: DownstreamStatus; unverifiedReason?: string }>();
  episodesById = new Map<string, { row: NewSignalRow; state: OpenEpisodeState }>();
  nextId = 1;
  findLatestEpisodeCalls = 0;
  updateEpisodeAtomicCalls: Array<{ fillId: string; signalId: string; state: OpenEpisodeState }> = [];
  markFillCompleteCalls: string[] = [];
  markFillTerminalCalls: Array<{ fillId: string; status: string }> = [];
  markFillTerminalUnverifiedCalls: Array<{ fillId: string; reasonCode: string }> = [];
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

  /** Mirrors the real batched upsert's all-or-nothing-per-call semantics: one configured failing eventKey anywhere in the batch fails the whole call (same as the real single `.upsert(array)` statement), never just that one row. */
  insertRawFillsBatchCalls: RawFillRow[][] = [];
  async insertRawFillsBatch(rows: RawFillRow[]) {
    this.insertRawFillsBatchCalls.push(rows);
    if (this.throwOnInsertRawFillFor && rows.some((r) => r.eventKey === this.throwOnInsertRawFillFor)) {
      throw new Error("simulated insertRawFillsBatch failure");
    }
    return rows.map((row) => {
      const existing = this.fillsByEventKey.get(row.eventKey);
      if (existing) return { eventKey: row.eventKey, id: existing.id, inserted: false };
      const id = `fill-${this.nextId++}`;
      const entry = { id, row, downstreamStatus: "PENDING" as DownstreamStatus };
      this.fillsByEventKey.set(row.eventKey, entry);
      this.fillsById.set(id, entry);
      return { eventKey: row.eventKey, id, inserted: true };
    });
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

  async markFillTerminalUnverified(fillId: string, reasonCode: UnverifiedReasonCode): Promise<void> {
    this.markFillTerminalUnverifiedCalls.push({ fillId, reasonCode });
    const fill = this.fillsById.get(fillId);
    if (fill) {
      fill.downstreamStatus = "TERMINAL_UNVERIFIED";
      fill.unverifiedReason = reasonCode;
    }
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

  it("Task 13G / P1-Q: does NOT mark backlogTruncated for a genuine first-ever bootstrap that crosses the go-live boundary within page 0 -- a deliberate design stopping point (B7), not a truncation, even though the source has far more (pre-go-live) history available", async () => {
    // The mocked source would happily serve a full page at ANY offset (SHARED_FULL_PAGE) --
    // i.e. this wallet genuinely has more history than bootstrap ever looks at. Every row
    // shares the SAME fixed timestamp (1_700_000_000); goLiveAtMs is set just after it, so
    // page 0 alone proves every one of these rows -- and by extension everything older --
    // is pre-go-live. Confirms that stopping here is a deliberate, PROVEN design choice
    // (B7: never silently "complete" via a deadline race) rather than an accident.
    const { deps } = makeDeps({ network: makeNetworkDeps(() => SHARED_FULL_PAGE) });
    const goLiveAtMs = 1_700_000_001_000; // 1s after every mocked row's timestamp
    const result = await pollSportsShadowWallet(WALLET, goLiveAtMs, deps);
    expect(result.isBootstrap).toBe(true);
    expect(result.pagesFetched).toBe(1);
    expect(result.backlogTruncated).toBe(false);
  });

  it("Task 13G / P1-Q (Codex re-review): a first-ever bootstrap walks MULTIPLE pages when more than PAGE_SIZE trades occurred since go-live, rather than silently stranding them behind a fixed one-page cap", async () => {
    const goLiveAtMs = 1_699_999_000_000; // well before every mocked row's timestamp -- nothing in this mocked history is pre-go-live
    const { repo, deps } = makeDeps({ network: makeNetworkDeps(() => SHARED_FULL_PAGE) });
    const result = await pollSportsShadowWallet(WALLET, goLiveAtMs, deps);
    expect(result.isBootstrap).toBe(true);
    // Never crosses (every row is identically timestamped and post-go-live) -- walks all
    // the way to the accepted MAX_PAGES_PER_WALLET historical-depth boundary, exactly like
    // steady-state resumption would for the same content.
    expect(result.pagesFetched).toBe(MAX_PAGES_PER_WALLET);
    expect(result.backlogTruncated).toBe(true);
    expect(repo.fillsByEventKey.size).toBe(PAGE_SIZE); // de-duplicated: SHARED_FULL_PAGE is identical every page
  });

  it("Task 13G / P1-Q: a mid-pagination fetch error discards the whole scan -- nothing is persisted, never a false partial commit", async () => {
    // Steady-state (hasHistory=true): pre-seed one durable fill for a DIFFERENT wallet
    // position so this poll is resumption, not bootstrap -- bootstrap's single-page design
    // (BOOTSTRAP_MAX_PAGES=1) never attempts a second page, so a mid-pagination throw can
    // only be exercised against the multi-page steady-state path.
    const repo = new FakeRepo();
    repo.fillsByEventKey.set("sid:seed", { id: "fill-seed", row: { eventKey: "sid:seed", wallet: WALLET.toLowerCase() } as RawFillRow, downstreamStatus: "COMPLETE" });
    const fullPage = Array.from({ length: PAGE_SIZE }, (_, i) => trade({ id: `native-0-${i}`, transactionHash: `0xtx-0-${i}` }));
    const { deps } = makeDeps({
      repo,
      network: makeNetworkDeps((offset) => (offset === 0 ? fullPage : new Error("network down"))),
    });
    const result = await pollSportsShadowWallet(WALLET, 0, deps);
    expect(result.pagesFetched).toBe(1);
    expect(result.rowsFetched).toBe(PAGE_SIZE);
    expect(result.error).toContain("trade page fetch failed");
    // Task 13G / P1-Q: an interrupted (error-terminated) scan is NOT confirmed complete --
    // its fetched-but-unconfirmed page is discarded entirely, never persisted. Persisting
    // it would create exactly the false stepping-stone P1-Q's fix eliminates. The wallet's
    // next poll re-fetches from page 0 and, absent further errors, persists the full,
    // gapless range in one pass.
    expect(result.newRows).toBe(0);
    expect(repo.fillsByEventKey.size).toBe(1); // only the pre-seeded row, nothing new
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

  it("routes a RETRYABLE UNVERIFIED reason (transport/response-availability) to unverifiedRows and leaves the fill PENDING (retried next poll, never treated as permanently processed)", async () => {
    const repo = new FakeRepo();
    // Task 12F / P1-H: UNVERIFIED_FETCH_FAILED is generated by fetchSourceMarketMetadata's
    // OWN network wrapper, before classifyGammaMarket ever runs -- genuinely transient,
    // must stay PENDING. See the dedicated Task 12F/P1-H describe block below for the
    // TERMINAL classifier-reason routing this test previously (incorrectly, pre-P1-H)
    // exercised via UNVERIFIED_METADATA_MISSING.
    const unverified: SourceMarketMetadata = { ...ELIGIBLE_METADATA, status: "UNVERIFIED", betType: null, reasonCode: "UNVERIFIED_FETCH_FAILED" };
    const { deps } = makeDeps({
      repo,
      network: makeNetworkDeps({ 0: [trade()] }),
      fetchSourceMarketMetadata: vi.fn(async () => unverified) as unknown as WalletPollDeps["fetchSourceMarketMetadata"],
    });
    const result = await pollSportsShadowWallet(WALLET, 0, deps);
    expect(result.unverifiedRows).toBe(1);
    expect(result.terminalUnverifiedRows).toBe(0);
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
    // Bootstrap (empty repo, single-page scan, Task 13G / P1-Q) never runs the per-page
    // overlap check at all -- findExistingEventKeys is called exactly once, for the final
    // dedup pass after the (confirmed-complete, one-page) scan. throwOnFindExisting
    // exercises exactly that call.
    const repo = new FakeRepo();
    repo.throwOnFindExisting = new Error("final dedup query failed");
    const { deps } = makeDeps({ repo, network: makeNetworkDeps({ 0: [trade()] }) });
    const result = await pollSportsShadowWallet(WALLET, 0, deps);
    expect(result.error).toContain("final dedup query failed");
    expect(result.newRows).toBe(1);
  });

  it("Task 13G / P1-R: a batch insert failure leaves the whole batch un-persisted, safely retried next poll (batch-atomic, matching a real single upsert statement)", async () => {
    const repo = new FakeRepo();
    repo.throwOnInsertRawFillFor = "sid:native-bad";
    const { deps } = makeDeps({
      repo,
      network: makeNetworkDeps({
        0: [trade({ id: "native-bad", timestamp: 1_700_000_000 }), trade({ id: "native-good", timestamp: 1_700_000_100 })],
      }),
    });
    const result = await pollSportsShadowWallet(WALLET, 0, deps);
    // Both rows share one PERSIST_BATCH_SIZE-bounded batch (only 2 rows total), so the
    // configured failure fails the whole batch -- exactly like a real single `.upsert(array)`
    // statement would. Neither row is durably persisted; both stay genuinely-new and are
    // retried, fully idempotently, on the wallet's next poll.
    expect(result.newRows).toBe(0);
    expect(result.invalidRows).toBe(2);
    expect(result.error).toContain("insertRawFillsBatch failed");
    expect(repo.fillsByEventKey.size).toBe(0);
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

  it("E. Task 13G (Codex re-review round 3, P1): ordinal assignment order matches persist order, so a batch failure never causes later reconciliation to skip the wrong occurrence", async () => {
    const repo = new FakeRepo();
    const rowX = collidingRow("X"); // will land on the OLDER page (offset=250)
    const rowY = collidingRow("Y"); // will land on the NEWER page (offset=0)
    const filler = (n: number, prefix: string) =>
      Array.from({ length: n }, (_, i) => trade({ id: `filler-${prefix}-${i}`, transactionHash: `0xfiller-${prefix}-${i}`, conditionId: null }));
    const page0 = [rowY, ...filler(249, "a")]; // full page -> pagination continues to page1
    const page1 = [rowX]; // short page -> natural end
    const network = makeNetworkDeps({ 0: page0, [PAGE_SIZE]: page1 });

    // Ordinal assignment now follows oldest-page-first order (same as persist order): rowX
    // (older page) gets "#0", rowY (newer page) gets "#1". Fail the NEWER page's batch
    // specifically -- this exercises exactly the case Codex's finding described: an older
    // batch (page1/rowX/"#0") persists successfully BEFORE a newer batch (page0/rowY/"#1")
    // fails.
    repo.throwOnInsertRawFillFor = `${COLLIDE_TUPLE_PREFIX}1`;
    const { deps: depsA } = makeDeps({ repo, network });
    const pollA = await pollSportsShadowWallet(WALLET, 0, depsA);
    expect(pollA.error).toContain("insertRawFillsBatch failed");
    expect(countDurableForTuple(repo, WALLET.toLowerCase())).toBe(1);
    expect([...repo.fillsByEventKey.keys()]).toContain(`${COLLIDE_TUPLE_PREFIX}0`);

    // Poll 2 (healthy repo): must correctly identify rowY -- still genuinely missing -- as
    // the excess to insert. Before this fix, ordinal assignment (newest-page-first) and
    // persist order (oldest-page-first) disagreed, so reconcileDegradedEvents's
    // durable-count-implies-lowest-ordinals assumption would have wrongly treated "#0" as
    // the missing one and kept re-conflicting on the already-durable "#0" while never
    // inserting "#1".
    repo.throwOnInsertRawFillFor = null;
    const { deps: depsB } = makeDeps({ repo, network });
    const pollB = await pollSportsShadowWallet(WALLET, 0, depsB);
    expect(pollB.error).toBeNull();
    expect(countDurableForTuple(repo, WALLET.toLowerCase())).toBe(2);
  });

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
    // This is the wallet's first-ever poll (empty repo) with goLiveAtMs=0 -- since every
    // mocked row's timestamp is a realistic positive value, none of them is ever
    // "pre-go-live," so bootstrap (Task 13G / P1-Q's go-live-aware design) correctly keeps
    // paging past page 0 -- reaching page 1's short/natural end -- and captures BOTH
    // physical fills of the colliding tuple in this single poll.
    const page0 = [...filler(249, "a"), rowX];
    const page1 = [rowY];
    const { deps: depsA } = makeDeps({ repo, network: makeNetworkDeps({ 0: page0, [PAGE_SIZE]: page1 }) });
    const pollA = await pollSportsShadowWallet(WALLET, 0, depsA);
    expect(pollA.pagesFetched).toBe(2);
    expect(countDurableForTuple(repo, WALLET.toLowerCase())).toBe(2);

    // Poll B: the boundary has "shifted" -- both physical fills now land together on one
    // page. Wallet now hasHistory=true (steady-state); both are already durable, so this
    // must reconcile as pure duplicates regardless of the new page arrangement.
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

/** Directly seeds a durably-PENDING fill into a FakeRepo, bypassing insertRawFill/pagination -- for tests that need to construct a large or specifically-shaped pending backlog. */
function seedPendingFill(repo: FakeRepo, id: string, overrides: Partial<RawFillRow> = {}): void {
  const row: RawFillRow = {
    eventKey: `seed:${id}`,
    wallet: WALLET.toLowerCase(),
    walletHandle: "Talvez10",
    conditionId: `0xcondition-${id}`,
    asset: "0xasset",
    marketTitle: "Seed Market",
    outcome: "Team",
    eventSlug: "seed-event",
    marketSlug: "seed-market",
    side: "BUY",
    shares: 10,
    price: 0.5,
    sourceTs: 1_700_000_000,
    identityBasis: "source_id",
    identityDegraded: false,
    raw: {},
    ...overrides,
  };
  const entry = { id, row, downstreamStatus: "PENDING" as const };
  repo.fillsByEventKey.set(row.eventKey, entry);
  repo.fillsById.set(id, entry);
}

describe("pollSportsShadowWallet — Task 12F/P1-H: retryable vs terminal UNVERIFIED", () => {
  it("H1/H2: >500 old permanently-UNVERIFIED fills are terminalized (not left PENDING forever), which frees a newer eligible fill to be reached and processed on the next poll", async () => {
    const repo = new FakeRepo();
    expect(MAX_PENDING_FILLS_PER_POLL).toBe(500);

    // 505 old fills, oldest-first by sourceTs, all sharing a conditionId that always
    // classifies UNVERIFIED_UNKNOWN_TEAM (a deterministic, successful-response classifier
    // outcome -- exactly the P1-H starvation scenario).
    for (let i = 0; i < 505; i += 1) {
      seedPendingFill(repo, `poison-${i}`, { sourceTs: 1_700_000_000 + i, conditionId: "0xpoison" });
    }
    // One genuinely NEWER, otherwise-eligible fill.
    seedPendingFill(repo, "good-1", { sourceTs: 1_700_001_000, conditionId: "0xcondition-1" });

    const poisonMetadata: SourceMarketMetadata = { ...ELIGIBLE_METADATA, conditionId: "0xpoison", status: "UNVERIFIED", betType: null, reasonCode: "UNVERIFIED_UNKNOWN_TEAM" };
    const fetchSourceMarketMetadata = vi.fn(async (conditionId: string) => (conditionId === "0xpoison" ? poisonMetadata : ELIGIBLE_METADATA));
    const { deps } = makeDeps({
      repo,
      network: makeNetworkDeps({ 0: [] }),
      fetchSourceMarketMetadata: fetchSourceMarketMetadata as unknown as WalletPollDeps["fetchSourceMarketMetadata"],
    });

    // First poll: the bounded 500-row batch (oldest first) is entirely poison fills -- the
    // newer "good-1" fill is not even IN this batch yet (505 poison fills sort ahead of it).
    const first = await pollSportsShadowWallet(WALLET, 0, deps);
    expect(first.terminalUnverifiedRows).toBe(500);
    expect(first.newSignals).toHaveLength(0);
    const stillPendingAfterFirst = [...repo.fillsByEventKey.values()].filter((f) => f.downstreamStatus === "PENDING").length;
    expect(stillPendingAfterFirst).toBe(6); // 5 remaining poison fills + the 1 good fill

    // Second poll: the previously-terminalized 500 no longer occupy PENDING capacity, so
    // THIS batch reaches "good-1" -- H2's proof that terminalizing frees retry capacity.
    const second = await pollSportsShadowWallet(WALLET, 0, deps);
    expect(second.terminalUnverifiedRows).toBe(5); // the remaining 5 poison fills
    expect(second.newSignals).toHaveLength(1);
    expect(second.newSignals[0]?.conditionId).toBe("0xcondition-1");

    // H12: terminal-unverified evidence durably retains its exact reason code.
    const terminalized = [...repo.fillsByEventKey.values()].filter((f) => f.downstreamStatus === "TERMINAL_UNVERIFIED");
    expect(terminalized).toHaveLength(505);
    for (const f of terminalized) expect(f.unverifiedReason).toBe("UNVERIFIED_UNKNOWN_TEAM");
  });

  it("H11: a semantic UNVERIFIED classification (retryable OR terminal) never itself becomes an eligible source signal", async () => {
    const repo = new FakeRepo();
    for (const reasonCode of ["UNVERIFIED_FETCH_FAILED", "UNVERIFIED_UNKNOWN_TEAM", "UNVERIFIED_MISSING_LINE"] as const) {
      seedPendingFill(repo, `u-${reasonCode}`, { conditionId: `0x${reasonCode}` });
    }
    const fetchSourceMarketMetadata = vi.fn(async (conditionId: string) => {
      const reasonCode = conditionId.slice(2) as SourceMarketMetadata["reasonCode"];
      return { ...ELIGIBLE_METADATA, conditionId, status: "UNVERIFIED", betType: null, reasonCode } satisfies SourceMarketMetadata;
    });
    const { deps } = makeDeps({
      repo,
      network: makeNetworkDeps({ 0: [] }),
      fetchSourceMarketMetadata: fetchSourceMarketMetadata as unknown as WalletPollDeps["fetchSourceMarketMetadata"],
    });
    const result = await pollSportsShadowWallet(WALLET, 0, deps);
    expect(result.newSignals).toHaveLength(0);
    expect(repo.episodesById.size).toBe(0);
  });

  it("H13: Task 12D's durable retry mechanism remains intact -- a fill left PENDING by a transient metadata failure is still recovered and processed on a later poll", async () => {
    const repo = new FakeRepo();
    seedPendingFill(repo, "transient-1", { conditionId: "0xcondition-1" });
    let shouldThrow = true;
    const fetchSourceMarketMetadata = vi.fn(async () => {
      if (shouldThrow) throw new Error("simulated transient gamma-api failure");
      return ELIGIBLE_METADATA;
    });
    const { deps } = makeDeps({ repo, network: makeNetworkDeps({ 0: [] }), fetchSourceMarketMetadata: fetchSourceMarketMetadata as unknown as WalletPollDeps["fetchSourceMarketMetadata"] });

    const first = await pollSportsShadowWallet(WALLET, 0, deps);
    expect(first.metadataFetchFailures).toBe(1);
    expect([...repo.fillsByEventKey.values()][0]?.downstreamStatus).toBe("PENDING");

    shouldThrow = false;
    const second = await pollSportsShadowWallet(WALLET, 0, deps);
    expect(second.orphanedFillsRecovered).toBe(1);
    expect(second.newSignals).toHaveLength(1);
  });

  it("H14: Task 12E's immutable go-live behavior remains intact -- a pre-go-live fill is still suppressed regardless of UNVERIFIED disposition routing changes", async () => {
    const repo = new FakeRepo();
    seedPendingFill(repo, "pre-go-live-1", { conditionId: "0xcondition-1", sourceTs: 1_700_000_000 });
    const goLiveAtMs = 1_700_000_000_000 + 3_600_000;
    const { deps } = makeDeps({ repo, network: makeNetworkDeps({ 0: [] }) });
    const result = await pollSportsShadowWallet(WALLET, goLiveAtMs, deps);
    expect(result.suppressedPreGoLive).toBe(1);
    expect(result.newSignals).toHaveLength(0);
  });
});

describe("pollSportsShadowWallet — Task 12F/P1-G: lease checkpoint stops non-idempotent work", () => {
  it("G6: if the checkpoint fails at the top of a pending-fill iteration, the poll stops before starting further non-idempotent downstream work (metadata is never even fetched for it)", async () => {
    const repo = new FakeRepo();
    seedPendingFill(repo, "fill-1", { conditionId: "0xcondition-1" });
    const fetchSourceMarketMetadata = vi.fn(async () => ELIGIBLE_METADATA);
    const checkpointLease: LeaseCheckpoint = async () => false; // already lost before phase 2 even starts
    const { deps } = makeDeps({
      repo,
      network: makeNetworkDeps({ 0: [] }),
      fetchSourceMarketMetadata: fetchSourceMarketMetadata as unknown as WalletPollDeps["fetchSourceMarketMetadata"],
      checkpointLease,
    });
    const result = await pollSportsShadowWallet(WALLET, 0, deps);
    expect(result.leaseLost).toBe(true);
    expect(fetchSourceMarketMetadata).not.toHaveBeenCalled();
    expect([...repo.fillsByEventKey.values()][0]?.downstreamStatus).toBe("PENDING");
  });

  it("G7: if the checkpoint fails AFTER a slow metadata fetch returns (but before the episode write), the old worker does NOT perform the state-changing write", async () => {
    const repo = new FakeRepo();
    seedPendingFill(repo, "fill-1", { conditionId: "0xcondition-1" });
    let checkpointCalls = 0;
    const checkpointLease: LeaseCheckpoint = async () => {
      checkpointCalls += 1;
      // First call (top of the phase-2 iteration, before the metadata fetch) succeeds;
      // the SECOND call (immediately before insertEpisodeAtomic, i.e. AFTER the metadata
      // "await" completed) reports the lease lost.
      return checkpointCalls === 1;
    };
    const { deps } = makeDeps({
      repo,
      network: makeNetworkDeps({ 0: [] }),
      fetchSourceMarketMetadata: vi.fn(async () => ELIGIBLE_METADATA) as unknown as WalletPollDeps["fetchSourceMarketMetadata"],
      checkpointLease,
    });
    const result = await pollSportsShadowWallet(WALLET, 0, deps);
    expect(result.leaseLost).toBe(true);
    expect(result.newSignals).toHaveLength(0);
    expect(repo.episodesById.size).toBe(0); // the write never happened
    expect([...repo.fillsByEventKey.values()][0]?.downstreamStatus).toBe("PENDING"); // safely retryable
  });

  it("checkpointLease defaulting to NO_OP_LEASE_CHECKPOINT never reports lease loss for a caller not exercising this behavior", async () => {
    expect(await NO_OP_LEASE_CHECKPOINT()).toBe(true);
  });

  it("Task 13G / P1-Q: a checkpoint failure mid-pagination stops fetching further pages, skips phase 2 entirely, and discards the already-fetched page too -- a lease-loss interruption obeys the exact same no-stranding invariant as a deadline interruption", async () => {
    const fullPage = Array.from({ length: PAGE_SIZE }, (_, i) => trade({ id: `native-page0-${i}`, transactionHash: `0xtx-page0-${i}` }));
    let checkpointCalls = 0;
    const checkpointLease: LeaseCheckpoint = async () => {
      checkpointCalls += 1;
      return checkpointCalls === 1; // page 0's checkpoint succeeds, page 1's fails
    };
    const { repo, deps } = makeDeps({
      network: makeNetworkDeps({ 0: fullPage, [PAGE_SIZE]: [trade({ id: "native-page1-0", transactionHash: "0xtx-page1-0" })] }),
      checkpointLease,
    });
    const result = await pollSportsShadowWallet(WALLET, 0, deps);
    expect(result.leaseLost).toBe(true);
    expect(result.pagesFetched).toBe(1); // page 1 was never fetched
    // Task 13G / P1-Q: an interrupted (lease-lost) scan is NOT confirmed complete -- page
    // 0's rows are discarded entirely, never persisted, exactly like a deadline stop. See
    // the "formal proof" describe block's dedicated lease-loss variant.
    expect(result.newRows).toBe(0);
    expect(repo.fillsByEventKey.size).toBe(0);
    expect(repo.findLatestEpisodeCalls).toBe(0); // phase 2 never started
  });
});

/** Returns each value in `values` in order on successive calls, then repeats the last one forever -- lets a test precisely script `d.now()`'s return sequence across an unknown number of internal calls. */
function sequentialClock(values: number[]): () => number {
  let i = 0;
  return () => {
    const v = values[Math.min(i, values.length - 1)]!;
    i += 1;
    return v;
  };
}

function fullPageFetcher(callLog: number[]): SourcePollNetworkDeps {
  let call = 0;
  return {
    fetchImpl: (async (url: string | URL) => {
      call += 1;
      callLog.push(call);
      const u = new URL(String(url));
      const offset = Number(u.searchParams.get("offset"));
      // Always a FULL page with a unique tx hash per row, so pagination never finds a
      // natural short-page stop or an overlap -- it would keep going indefinitely
      // (bounded only by MAX_PAGES_PER_WALLET/MAX_TRADES_OFFSET) without a deadline.
      const rows = Array.from({ length: PAGE_SIZE }, (_, i) => trade({ id: `p${offset}-${i}`, transactionHash: `0xtx-${offset}-${i}` }));
      return new Response(JSON.stringify(rows), { status: 200, headers: { "content-type": "application/json" } });
    }) as typeof fetch,
    reserveRequestSlot: async () => 0,
    getHostCooldown: async () => ({ blocked: false, reason: null }),
    recordHostRateLimit: async () => {},
  };
}

describe("Task 13F: a per-wallet deadline bounds Phase 1 (pagination) and Phase 2 (pending-fill/metadata resolution) WITHIN one wallet's own poll, not just between wallets", () => {
  it("reproduction: WITHOUT a deadline, a STEADY-STATE wallet (prior history, closing a large gap) keeps paginating past what any single HTTP response should stay open for (bounded only by MAX_PAGES_PER_WALLET, not by wall time)", async () => {
    const callLog: number[] = [];
    const repo = new FakeRepo();
    // Task 13G / P1-Q: a wallet's FIRST-EVER poll (bootstrap) is now bounded to exactly
    // BOOTSTRAP_MAX_PAGES=1 by design (see the module doc comment's "FORWARD-ONLY
    // BOOTSTRAP" section) -- it can no longer reproduce an unbounded multi-page walk.
    // The remaining, still-real risk this reproduction covers is STEADY-STATE resumption
    // closing an unusually large gap (e.g. after a scheduler outage): pre-seed one
    // durable fill so hasAnyFillsForWallet is true and the full MAX_PAGES_PER_WALLET
    // ceiling is back in play.
    repo.fillsByEventKey.set("sid:seed", { id: "fill-seed", row: { eventKey: "sid:seed", wallet: WALLET.toLowerCase() } as RawFillRow, downstreamStatus: "COMPLETE" });
    const result = await pollSportsShadowWallet(WALLET, 0, {
      repo,
      now: () => 1_700_000_500_000,
      fetchSourceMarketMetadata: vi.fn(async () => ELIGIBLE_METADATA) as unknown as WalletPollDeps["fetchSourceMarketMetadata"],
      network: fullPageFetcher(callLog),
    }); // no deadlineAtMs argument at all -- today's exact pre-Task-13F call shape
    expect(result.pagesFetched).toBe(MAX_PAGES_PER_WALLET); // ran all the way to the hard page cap, unbounded by time
  });

  it("Task 13G / P1-Q: a deadline reached mid-pagination (STEADY-STATE) stops fetching further pages AND discards whatever was fetched -- nothing is persisted from an unconfirmed scan", async () => {
    const callLog: number[] = [];
    const repo = new FakeRepo();
    repo.fillsByEventKey.set("sid:seed", { id: "fill-seed", row: { eventKey: "sid:seed", wallet: WALLET.toLowerCase() } as RawFillRow, downstreamStatus: "COMPLETE" });
    const base = 1_700_000_500_000;
    // Called once for detectedAtMs, then per page-loop iteration: a deadline check before
    // checkpointLease, one after it, then (Task 13I / P1-T) pacedFetchTradesPage's own THREE
    // internal deadline checks (before cooldown, after cooldown, after pacing wait) for
    // page 0's fetch to actually complete -- 6 calls total before page 1's top-of-loop
    // check finally sees the exceeded deadline.
    const now = sequentialClock([base, base, base, base, base, base, base + 999_999]);
    const deadlineAtMs = base + 500;
    const result = await pollSportsShadowWallet(
      WALLET,
      0,
      {
        repo,
        now,
        fetchSourceMarketMetadata: vi.fn(async () => ELIGIBLE_METADATA) as unknown as WalletPollDeps["fetchSourceMarketMetadata"],
        network: fullPageFetcher(callLog),
      },
      deadlineAtMs,
    );
    expect(result.pagesFetched).toBeLessThan(MAX_PAGES_PER_WALLET); // stopped early, not at the hard cap
    expect(result.pagesFetched).toBeGreaterThan(0); // network activity did happen before the deadline tripped
    // Task 13G / P1-Q: the fetched-but-unconfirmed pages are discarded, NOT persisted --
    // an interrupted scan must never durably commit partial progress, or a later poll
    // could mistake it for a genuine completeness boundary (the exact P1-Q stranding bug).
    expect(result.newRows).toBe(0);
    expect(repo.fillsByEventKey.size).toBe(1); // only the pre-seeded row
    expect(result.backlogTruncated).toBe(true);
  });

  it("Task 13G / P1-Q: a deadline reached before EVEN the first page's fetch sets backlogTruncated=true for a BOOTSTRAP poll too -- never silently 'done' merely because the deadline fired first", async () => {
    const callLog: number[] = [];
    const repo = new FakeRepo(); // empty -- this wallet has zero prior history, isBootstrap will be true
    const base = 1_700_000_500_000;
    // Deadline already reached by the time the (single, bootstrap) page-0 check runs.
    const result = await pollSportsShadowWallet(
      WALLET,
      0,
      {
        repo,
        now: () => base,
        fetchSourceMarketMetadata: vi.fn(async () => ELIGIBLE_METADATA) as unknown as WalletPollDeps["fetchSourceMarketMetadata"],
        network: fullPageFetcher(callLog),
      },
      base, // deadline == now -- exceeded at the very first check
    );
    expect(result.isBootstrap).toBe(true);
    expect(result.pagesFetched).toBe(0); // never even attempted page 0
    expect(result.newRows).toBe(0);
    expect(result.backlogTruncated).toBe(true); // never silently "done" -- retried as bootstrap again next poll
  });

  it("Task 13G / P1-Q: when NO new trades occur between polls, an interrupted poll persists nothing, and the FOLLOWING poll (generous deadline) completes and persists everything exactly once -- no duplicate insert, no crash (the simple, static-history case)", async () => {
    const repo = new FakeRepo();
    repo.fillsByEventKey.set("sid:seed", { id: "fill-seed", row: { eventKey: "sid:seed", wallet: WALLET.toLowerCase() } as RawFillRow, downstreamStatus: "COMPLETE" });
    // A bounded, static two-page history (a full page 0, a short page 1) -- naturally
    // reaches a short-page stop, so the test stays fast without relying on the 41-page
    // MAX_PAGES_PER_WALLET ceiling.
    const page0 = Array.from({ length: PAGE_SIZE }, (_, i) => trade({ id: `static-0-${i}`, transactionHash: `0xtx-static-0-${i}` }));
    const page1 = Array.from({ length: 50 }, (_, i) => trade({ id: `static-1-${i}`, transactionHash: `0xtx-static-1-${i}` }));
    const network = makeNetworkDeps({ 0: page0, [PAGE_SIZE]: page1 });
    const base = 1_700_000_500_000;

    // Calls: 1) detectedAtMs, 2) page=0's top-of-loop deadline check (within budget), 3)
    // the post-checkpointLease deadline recheck (still within budget), 4-6) (Task 13I /
    // P1-T) pacedFetchTradesPage's own three internal deadline checks (before cooldown,
    // after cooldown, after pacing wait) so page 0 actually completes, 7) page=1's
    // top-of-loop deadline check (now exceeded) -- interrupted after exactly one full
    // page, before ever reaching page 1's short-page natural end.
    const firstNow = sequentialClock([base, base, base, base, base, base, base + 999_999]);
    const first = await pollSportsShadowWallet(
      WALLET,
      0,
      { repo, now: firstNow, fetchSourceMarketMetadata: vi.fn(async () => ELIGIBLE_METADATA) as unknown as WalletPollDeps["fetchSourceMarketMetadata"], network },
      base + 500,
    );
    expect(first.pagesFetched).toBe(1);
    expect(first.backlogTruncated).toBe(true);
    // Task 13G / P1-Q: an interrupted scan persists NOTHING -- only the pre-seeded row exists.
    expect(repo.fillsByEventKey.size).toBe(1);

    // Second poll, same static page content (the wallet made no new trades in between),
    // generous deadline this time -- walks all the way to a natural/MAX_PAGES boundary and
    // persists the full range in one confirmed-complete pass.
    const second = await pollSportsShadowWallet(
      WALLET,
      0,
      { repo, now: () => base + 10_000, fetchSourceMarketMetadata: vi.fn(async () => ELIGIBLE_METADATA) as unknown as WalletPollDeps["fetchSourceMarketMetadata"], network },
      base + 10_000 + 999_999,
    );
    expect(second.newRows).toBeGreaterThan(0);
    const persistedAfterSecond = repo.fillsByEventKey.size;
    expect(persistedAfterSecond).toBeGreaterThan(1);

    // Third poll, still the exact same static content -- everything is now already durable,
    // pagination should recognize overlap promptly and insert nothing new.
    const third = await pollSportsShadowWallet(
      WALLET,
      0,
      { repo, now: () => base + 20_000, fetchSourceMarketMetadata: vi.fn(async () => ELIGIBLE_METADATA) as unknown as WalletPollDeps["fetchSourceMarketMetadata"], network },
      base + 20_000 + 999_999,
    );
    expect(third.newRows).toBe(0);
    expect(repo.fillsByEventKey.size).toBe(persistedAfterSecond); // no duplicate insert
  });

});

describe("Task 13I / P1-T: pacedFetchTradesPage threads the caller's deadline into cooldown/reservation/pacing, not just the outer per-page pre-check", () => {
  it("a reservation whose granted wait would land at/after the caller's deadline is deferred (no fetch attempted), even though the outer per-page pre-check alone would have allowed the call to start", async () => {
    const repo = new FakeRepo();
    const base = 1_700_000_500_000;
    let fetchCalls = 0;
    let capturedDeadline: number | undefined;
    const network: SourcePollNetworkDeps = {
      fetchImpl: (async () => {
        fetchCalls += 1;
        return new Response(JSON.stringify([]), { status: 200, headers: { "content-type": "application/json" } });
      }) as unknown as typeof fetch,
      // Simulates reserveRequestSlot's OWN real behavior (http-rate-limit.server.ts): a
      // granted wait that would land at/after the caller's deadline must be reported as
      // exhausted, never slept through into a request the caller no longer has budget for.
      reserveRequestSlot: async (_host: string, deadlineAtMs?: number) => {
        capturedDeadline = deadlineAtMs;
        const grantedWaitMs = 10_000; // would land far past this test's small deadline window
        if (deadlineAtMs !== undefined && base + grantedWaitMs >= deadlineAtMs) {
          throw new DeadlineExceededError("reservation granted but would land at/after the caller's own deadline");
        }
        return grantedWaitMs;
      },
      getHostCooldown: async () => ({ blocked: false, reason: null }),
      recordHostRateLimit: async () => {},
    };
    const deadlineAtMs = base + 500; // far tighter than the 10s granted reservation wait
    const result = await pollSportsShadowWallet(WALLET, 0, { repo, now: () => base, network }, deadlineAtMs);
    expect(capturedDeadline).toBe(deadlineAtMs); // the real caller deadline was actually forwarded
    expect(fetchCalls).toBe(0); // never reached the upstream fetch
    expect(result.pagesFetched).toBe(0);
    expect(result.backlogTruncated).toBe(true); // a deferral, not a silent "done"
    expect(result.error).toBeNull(); // never misreported as a genuine upstream/network failure
  });

  it("reserveRequestSlot receives NO deadline (undefined) when pollSportsShadowWallet is called with no deadlineAtMs argument at all -- exact prior call shape preserved", async () => {
    const repo = new FakeRepo();
    let capturedDeadline: number | undefined = 0;
    let sawCall = false;
    const network: SourcePollNetworkDeps = {
      fetchImpl: (async () => new Response(JSON.stringify([]), { status: 200, headers: { "content-type": "application/json" } })) as unknown as typeof fetch,
      reserveRequestSlot: async (_host: string, deadlineAtMs?: number) => {
        sawCall = true;
        capturedDeadline = deadlineAtMs;
        return 0;
      },
      getHostCooldown: async () => ({ blocked: false, reason: null }),
      recordHostRateLimit: async () => {},
    };
    await pollSportsShadowWallet(WALLET, 0, { repo, network }); // no deadlineAtMs argument
    expect(sawCall).toBe(true);
    // Internally Number.POSITIVE_INFINITY, but pacedFetchTradesPage must translate that
    // back to `undefined` before calling reserveRequestSlot -- the shared rate-limiter's
    // own backward-compatibility contract (T6) is keyed on an OMITTED argument, not a
    // finite-but-huge one.
    expect(capturedDeadline).toBeUndefined();
  });

  it("Codex re-review: a 429 whose cooldown recording would start AFTER the caller's deadline skips recordHostRateLimit entirely, but still surfaces the genuine 429 failure as result.error", async () => {
    const repo = new FakeRepo();
    const base = 1_700_000_500_000;
    let now = base;
    const deadlineAtMs = base + 100;
    const recordHostRateLimit = vi.fn(async () => {});
    const network: SourcePollNetworkDeps = {
      fetchImpl: (async () => {
        now += 200; // the already-in-flight fetch itself is what crosses the deadline
        return new Response("{}", { status: 429, headers: { "retry-after": "30" } });
      }) as unknown as typeof fetch,
      reserveRequestSlot: async () => 0,
      getHostCooldown: async () => ({ blocked: false, reason: null }),
      recordHostRateLimit,
    };
    const result = await pollSportsShadowWallet(WALLET, 0, { repo, now: () => now, network }, deadlineAtMs);
    expect(result.error).toMatch(/429/);
    expect(recordHostRateLimit).not.toHaveBeenCalled();
  });

  it("a 429 that returns comfortably within the caller's deadline still records the cooldown normally -- bounded recording is preserved when time remains", async () => {
    const repo = new FakeRepo();
    const base = 1_700_000_500_000;
    const deadlineAtMs = base + 100_000;
    const recordHostRateLimit = vi.fn(async () => {});
    const network: SourcePollNetworkDeps = {
      fetchImpl: (async () => new Response("{}", { status: 429, headers: { "retry-after": "30" } })) as unknown as typeof fetch,
      reserveRequestSlot: async () => 0,
      getHostCooldown: async () => ({ blocked: false, reason: null }),
      recordHostRateLimit,
    };
    const result = await pollSportsShadowWallet(WALLET, 0, { repo, now: () => base, network }, deadlineAtMs);
    expect(result.error).toMatch(/429/);
    expect(recordHostRateLimit).toHaveBeenCalledWith(DATA_API_HOST, 30_000);
  });
});

/* ======================================================================
 * TASK 13G / P1-Q: FORMAL ADVERSARIAL PROOF -- an incomplete scan can never
 * strand real source data. This describe block REPLACES Task 13F's
 * "DOCUMENTED RESIDUAL RISK" test, which only documented the loss (see git
 * history for the pre-fix version). Per the mission's own requirement, a test
 * that merely documents an unresolved risk is NOT acceptance -- every test
 * below asserts NO fill is ever permanently unreachable, across the exact
 * scenario the mission's own architectural warning describes plus the
 * required adversarial variants (repeated interruption, lease-loss stop,
 * >1-page shift). Each `pollSportsShadowWallet` call below gets a brand-new
 * WalletPollDeps object with no shared in-memory state except the FakeRepo
 * itself -- i.e. every poll below is already "restart between every cycle";
 * the ONLY durable continuity between polls is what actually landed in the
 * repo, exactly matching a real Cloudflare Workers invocation.
 * ====================================================================== */
describe("Task 13G / P1-Q: formal proof -- an incomplete scan can never create a durable overlap that strands unread source data", () => {
  function wavesNetwork(middleBatchEventKeys: Set<string>, getWave: () => number): SourcePollNetworkDeps {
    return {
      fetchImpl: (async (url: string | URL) => {
        const offset = Number(new URL(String(url)).searchParams.get("offset"));
        const wave = getWave();
        let rows: unknown[];
        if (offset === 0 && wave === 1) {
          rows = Array.from({ length: PAGE_SIZE }, (_, i) => trade({ id: `NEW_BATCH_1-${i}`, transactionHash: `0xtx-nb1-${i}` }));
        } else if (offset === 0 && wave === 2) {
          // New trades arrived since poll 1 -- today's newest page 0 is now DIFFERENT content.
          rows = Array.from({ length: PAGE_SIZE }, (_, i) => trade({ id: `NEW_BATCH_2-${i}`, transactionHash: `0xtx-nb2-${i}` }));
        } else if (offset === PAGE_SIZE && wave === 2) {
          // NEW_BATCH_1 has shifted from page 0 to page 1.
          rows = Array.from({ length: PAGE_SIZE }, (_, i) => trade({ id: `NEW_BATCH_1-${i}`, transactionHash: `0xtx-nb1-${i}` }));
        } else if (offset === PAGE_SIZE * 2) {
          rows = Array.from(middleBatchEventKeys).map((id) => trade({ id, transactionHash: `0xtx-${id}` }));
        } else {
          rows = []; // beyond MIDDLE_BATCH -- natural end of mocked history
        }
        return new Response(JSON.stringify(rows), { status: 200, headers: { "content-type": "application/json" } });
      }) as typeof fetch,
      reserveRequestSlot: async () => 0,
      getHostCooldown: async () => ({ blocked: false, reason: null }),
      recordHostRateLimit: async () => {},
    };
  }

  it("Task 13G / P1-Q (Codex re-review, P1): persistence is batched in ACTUAL oldest-fetched-page-first order, not re-sorted by sourceTs/eventKey", async () => {
    const repo = new FakeRepo();
    repo.fillsByEventKey.set("sid:seed", { id: "fill-seed", row: { eventKey: "sid:seed", wallet: WALLET.toLowerCase() } as RawFillRow, downstreamStatus: "COMPLETE" });
    // Every row across BOTH pages shares the exact same second-resolution timestamp and
    // lexically-DESCENDING ids (so sorting by (sourceTs, eventKey) would put page 0's rows
    // BEFORE page 1's -- the wrong, newest-first order -- if genuinelyNew were still built
    // via a global sourceTs/eventKey sort instead of actual page order).
    const page0 = Array.from({ length: PAGE_SIZE }, (_, i) => trade({ id: `z-page0-${String(PAGE_SIZE - i).padStart(4, "0")}`, transactionHash: `0xz-page0-${i}`, timestamp: 1_700_000_000 }));
    const page1 = Array.from({ length: 50 }, (_, i) => trade({ id: `a-page1-${String(50 - i).padStart(4, "0")}`, transactionHash: `0xa-page1-${i}`, timestamp: 1_700_000_000 }));
    const network = makeNetworkDeps({ 0: page0, [PAGE_SIZE]: page1 });
    const { deps } = makeDeps({ repo, network });
    const result = await pollSportsShadowWallet(WALLET, 0, deps);
    expect(result.error).toBeNull();
    expect(result.newRows).toBe(PAGE_SIZE + 50);
    // Batch call order: page 1 (older, fetched second, offset=250) must be inserted BEFORE
    // page 0 (newer, offset=0), regardless of lexical eventKey order within either page.
    const insertOrder = repo.insertRawFillsBatchCalls.map((batch) => batch[0]!.eventKey);
    const firstBatchIsPage1 = insertOrder[0]!.startsWith("sid:a-page1-");
    expect(firstBatchIsPage1).toBe(true);
    // Task 13G (Codex re-review round 3, P1): batches are aligned to PAGE boundaries, not
    // an arbitrary fixed-size window -- page 1 (50 rows) must land in its OWN batch, never
    // combined with any of page 0's 250 rows into one straddling batch.
    expect(repo.insertRawFillsBatchCalls).toHaveLength(2);
    expect(repo.insertRawFillsBatchCalls[0]).toHaveLength(50);
    expect(repo.insertRawFillsBatchCalls[1]).toHaveLength(PAGE_SIZE);
    expect(repo.insertRawFillsBatchCalls[0]!.every((r) => r.eventKey.startsWith("sid:a-page1-"))).toBe(true);
  });

  it("Task 13G (Codex re-review round 3, P1): the deadline is re-checked immediately before persistence starts, even for a confirmed-complete scan -- nothing is persisted if it has already passed by then", async () => {
    const repo = new FakeRepo();
    repo.fillsByEventKey.set("sid:seed", { id: "fill-seed", row: { eventKey: "sid:seed", wallet: WALLET.toLowerCase() } as RawFillRow, downstreamStatus: "COMPLETE" });
    // A short (naturally-completing) page, so the FETCH loop finishes via natural end --
    // scanConfirmedComplete=true -- but `now()` reports the deadline as already exceeded
    // by the time persistence itself is about to start. Calls: 1) detectedAtMs, 2) page 0's
    // top-of-loop deadline check (within budget), 3) the post-checkpointLease recheck
    // (also within budget, so the fetch proceeds and naturally completes via the short
    // page), 4) the readyToPersist check (now exceeded).
    const network = makeNetworkDeps({ 0: [trade({ id: "native-late" })] });
    const base = 1_700_000_500_000;
    const { deps } = makeDeps({ repo, network, now: sequentialClock([base, base, base, base + 999_999]) });
    const result = await pollSportsShadowWallet(WALLET, 0, deps, base + 500);
    expect(result.newRows).toBe(0);
    expect(repo.fillsByEventKey.size).toBe(1); // only the pre-seeded row
    expect(repo.insertRawFillsBatchCalls).toHaveLength(0); // persistence never started at all
    expect(result.backlogTruncated).toBe(true);
  });

  it("Task 13G (Codex re-review round 4, P1): the deadline is re-checked immediately after checkpointLease succeeds, before starting the next page fetch", async () => {
    const repo = new FakeRepo();
    repo.fillsByEventKey.set("sid:seed", { id: "fill-seed", row: { eventKey: "sid:seed", wallet: WALLET.toLowerCase() } as RawFillRow, downstreamStatus: "COMPLETE" });
    let fetchCalls = 0;
    const network: SourcePollNetworkDeps = {
      fetchImpl: (async () => {
        fetchCalls += 1;
        return new Response("[]", { status: 200, headers: { "content-type": "application/json" } });
      }) as typeof fetch,
      reserveRequestSlot: async () => 0,
      getHostCooldown: async () => ({ blocked: false, reason: null }),
      recordHostRateLimit: async () => {},
    };
    const base = 1_700_000_500_000;
    // Calls: 1) detectedAtMs, 2) page 0's top-of-loop deadline check (within budget --
    // checkpointLease then succeeds), 3) the post-checkpointLease recheck (now exceeded,
    // simulating real time having passed during a lease-renewal RPC).
    const now = sequentialClock([base, base, base + 999_999]);
    const { deps } = makeDeps({ repo, network, now });
    const result = await pollSportsShadowWallet(WALLET, 0, deps, base + 500);
    expect(fetchCalls).toBe(0); // the page fetch was never even attempted
    expect(result.pagesFetched).toBe(0);
    expect(result.backlogTruncated).toBe(true);
  });

  it("Task 13G (Codex re-review round 4, P1): the deadline is re-checked before degraded-event reconciliation starts, not just before findExistingEventKeys", async () => {
    const repo = new FakeRepo();
    // A degraded (tx_hash_ordinal) row: no native id, so it falls through to the ordinal
    // fallback identity scheme (see shadow-core.ts). A short page (1 row) so the fetch
    // loop finishes via natural end -- scanConfirmedComplete=true -- before the deadline
    // is exceeded specifically between findExistingEventKeys and degraded reconciliation.
    const degradedRow = trade({ id: undefined });
    const network = makeNetworkDeps({ 0: [degradedRow] });
    const base = 1_700_000_500_000;
    // Calls: 1) detectedAtMs, 2) page 0's top-of-loop check (ok), 3) post-checkpointLease
    // recheck (ok, page 0 fetched, natural end via short page), 4) readyToPersist check
    // (ok, findExistingEventKeys runs, no reliable events to find), 5) the recheck
    // immediately before degraded reconciliation (now exceeded).
    const now = sequentialClock([base, base, base, base, base + 999_999]);
    const { deps } = makeDeps({ repo, network, now });
    const result = await pollSportsShadowWallet(WALLET, 0, deps, base + 500);
    expect(result.newRows).toBe(0);
    expect(repo.fillsByEventKey.size).toBe(0);
    expect(result.backlogTruncated).toBe(true);
  });

  it("Task 13G / P1-Q (Codex re-review, P1): a persistence batch failure stops ALL further batches this poll, so only a contiguous run from the prior durable boundary can ever be committed", async () => {
    const repo = new FakeRepo();
    repo.fillsByEventKey.set("sid:seed", { id: "fill-seed", row: { eventKey: "sid:seed", wallet: WALLET.toLowerCase() } as RawFillRow, downstreamStatus: "COMPLETE" });
    // Two full pages of genuinely-new content -- oldest-page-first persist order means
    // page 1 (offset=250, older) is batch 0, page 0 (offset=0, newer) is batch 1.
    const page0 = Array.from({ length: PAGE_SIZE }, (_, i) => trade({ id: `page0-${i}`, transactionHash: `0xpage0-${i}` }));
    const page1 = Array.from({ length: PAGE_SIZE }, (_, i) => trade({ id: `page1-${i}`, transactionHash: `0xpage1-${i}` }));
    const network = makeNetworkDeps({ 0: page0, [PAGE_SIZE]: page1, [PAGE_SIZE * 2]: [] });
    // Fail the OLDER batch (page1) specifically.
    repo.throwOnInsertRawFillFor = "sid:page1-0";
    const { deps } = makeDeps({ repo, network });
    const result = await pollSportsShadowWallet(WALLET, 0, deps);
    expect(result.error).toContain("insertRawFillsBatch failed");
    // Neither batch is durable: the failed (older) batch obviously isn't, and the NEWER
    // batch must never be attempted once an OLDER batch has failed -- persisting it would
    // let a later poll's overlap check recognize the newer content as covered while the
    // older, failed batch stays permanently unreached.
    expect(result.newRows).toBe(0);
    expect(repo.fillsByEventKey.size).toBe(1); // only the pre-seeded row
    expect(repo.insertRawFillsBatchCalls.length).toBe(1); // the newer batch was never attempted
    expect(result.backlogTruncated).toBe(true);
  });

  it("Task 13G (Codex re-review round 9, P1): an EARLIER page's reconcile+persist commits durably even when a LATER page's degraded-reconciliation fails -- genuine incremental progress, not all-or-nothing per scan", async () => {
    const repo = new FakeRepo();
    repo.fillsByEventKey.set("sid:seed", { id: "fill-seed", row: { eventKey: "sid:seed", wallet: WALLET.toLowerCase() } as RawFillRow, downstreamStatus: "COMPLETE" });
    // page1 (older, offset=250): one degraded row that reconciles fine.
    // page0 (newer, offset=0): a FULL page (so pagination continues to page1) whose one
    // degraded row's reconciliation FAILS; the rest are reliable filler.
    const page1 = [trade({ id: undefined, transactionHash: "0xpage1-degraded" })];
    const page0 = [
      trade({ id: undefined, transactionHash: "0xpage0-degraded" }),
      ...Array.from({ length: PAGE_SIZE - 1 }, (_, i) => trade({ id: `page0-filler-${i}`, transactionHash: `0xpage0-filler-${i}` })),
    ];
    const network = makeNetworkDeps({ 0: page0, [PAGE_SIZE]: page1, [PAGE_SIZE * 2]: [] });
    // Pages are processed oldest-first (page1, then page0) -- fail only the SECOND call.
    let countCalls = 0;
    const originalCount = repo.countDurableOrdinalFills.bind(repo);
    repo.countDurableOrdinalFills = async (wallet: string, prefixes: string[]) => {
      countCalls += 1;
      if (countCalls === 2) throw new Error("simulated reconciliation failure on the newer page");
      return originalCount(wallet, prefixes);
    };
    const { deps } = makeDeps({ repo, network });
    const result = await pollSportsShadowWallet(WALLET, 0, deps);
    expect(result.error).toContain("simulated reconciliation failure");
    expect(result.backlogTruncated).toBe(true);
    // page1 (older, processed first) durably committed despite page0's later failure.
    expect(result.newRows).toBe(1);
    expect(repo.fillsByEventKey.size).toBe(2); // the pre-seeded row + page1's row
    const durableKeys = [...repo.fillsByEventKey.keys()];
    expect(durableKeys.some((k) => k.includes("0xpage1-degraded"))).toBe(true);
    expect(durableKeys.some((k) => k.includes("0xpage0-degraded"))).toBe(false);
  });

  it("CORE PROOF: deadline interruption + a 1-page shift of already-fetched content between polls never strands MIDDLE_BATCH", async () => {
    const repo = new FakeRepo();
    repo.fillsByEventKey.set("OLD_ANCHOR", { id: "fill-anchor", row: { eventKey: "OLD_ANCHOR", wallet: WALLET.toLowerCase() } as RawFillRow, downstreamStatus: "COMPLETE" });
    const middleBatchEventKeys = new Set(Array.from({ length: PAGE_SIZE }, (_, i) => `MIDDLE_BATCH-${i}`));
    let wave = 1;
    const network = wavesNetwork(middleBatchEventKeys, () => wave);
    const base = 1_700_000_500_000;

    // Poll 1: deadline hits right after page 0 (NEW_BATCH_1) -- never reaches MIDDLE_BATCH.
    const firstNow = sequentialClock([base, base, base + 999_999]);
    const first = await pollSportsShadowWallet(
      WALLET,
      0,
      { repo, now: firstNow, fetchSourceMarketMetadata: vi.fn(async () => ELIGIBLE_METADATA) as unknown as WalletPollDeps["fetchSourceMarketMetadata"], network },
      base + 500,
    );
    expect(first.backlogTruncated).toBe(true);
    // Task 13G / P1-Q: the interrupted scan persisted NOTHING -- NEW_BATCH_1 is NOT durable,
    // so it cannot become a false stepping-stone for poll 2.
    expect(first.newRows).toBe(0);
    expect(repo.fillsByEventKey.size).toBe(1); // only OLD_ANCHOR

    // New trades arrive; wave 2 begins -- NEW_BATCH_1 shifts from page 0 to page 1.
    wave = 2;

    // Poll 2: generous deadline. Since NEW_BATCH_1 was never persisted, pagination finds NO
    // overlap at page 1 either -- it must walk all the way to MIDDLE_BATCH (page 2) and the
    // natural end beyond it before this scan is confirmed complete.
    const second = await pollSportsShadowWallet(
      WALLET,
      0,
      { repo, now: () => base + 10_000, fetchSourceMarketMetadata: vi.fn(async () => ELIGIBLE_METADATA) as unknown as WalletPollDeps["fetchSourceMarketMetadata"], network },
      base + 10_000 + 999_999,
    );

    const durableKeys = new Set([...repo.fillsByEventKey.keys()]);
    const middleBatchPersisted = [...middleBatchEventKeys].every((k) => durableKeys.has(`sid:${k}`));
    // FINAL ASSERTION (Task 13G mission Section 4): every genuine source fill between the
    // original durable boundary (OLD_ANCHOR) and the newest source state (NEW_BATCH_2) is
    // eventually persisted exactly once. MIDDLE_BATCH is NOT stranded.
    expect(middleBatchPersisted).toBe(true);
    expect(durableKeys.has("sid:NEW_BATCH_1-0")).toBe(true);
    expect(durableKeys.has("sid:NEW_BATCH_2-0")).toBe(true);
    expect(second.pagesFetched).toBeGreaterThanOrEqual(3); // NEW_BATCH_2, NEW_BATCH_1, MIDDLE_BATCH
    expect(repo.fillsByEventKey.size).toBe(1 + PAGE_SIZE * 3); // OLD_ANCHOR + 3 full batches, each exactly once
  });

  it("VARIANT: repeated (3x) consecutive deadline interruptions, with new trades shifting pages between EVERY attempt, still never strands MIDDLE_BATCH", async () => {
    const repo = new FakeRepo();
    repo.fillsByEventKey.set("OLD_ANCHOR", { id: "fill-anchor", row: { eventKey: "OLD_ANCHOR", wallet: WALLET.toLowerCase() } as RawFillRow, downstreamStatus: "COMPLETE" });
    const middleBatchEventKeys = new Set(Array.from({ length: PAGE_SIZE }, (_, i) => `MIDDLE_BATCH-${i}`));
    let wave = 1;
    const network = wavesNetwork(middleBatchEventKeys, () => wave);
    const base = 1_700_000_500_000;

    // Three consecutive polls, each interrupted after exactly one page, each preceded by
    // "new trades" (wave flips 1 -> 2 -> 1 -> 2, alternating which content is at page 0).
    for (let attempt = 0; attempt < 3; attempt += 1) {
      wave = attempt % 2 === 0 ? 1 : 2;
      const now = sequentialClock([base, base, base + 999_999]);
      const result = await pollSportsShadowWallet(
        WALLET,
        0,
        { repo, now, fetchSourceMarketMetadata: vi.fn(async () => ELIGIBLE_METADATA) as unknown as WalletPollDeps["fetchSourceMarketMetadata"], network },
        base + 500,
      );
      expect(result.backlogTruncated).toBe(true);
      expect(result.newRows).toBe(0); // never a partial commit, no matter how many times this repeats
    }
    expect(repo.fillsByEventKey.size).toBe(1); // still only OLD_ANCHOR after 3 interruptions

    // Finally, a generous-deadline poll completes the scan.
    wave = 2;
    const final = await pollSportsShadowWallet(
      WALLET,
      0,
      { repo, now: () => base + 10_000, fetchSourceMarketMetadata: vi.fn(async () => ELIGIBLE_METADATA) as unknown as WalletPollDeps["fetchSourceMarketMetadata"], network },
      base + 10_000 + 999_999,
    );
    expect(final.error).toBeNull();
    const durableKeys = new Set([...repo.fillsByEventKey.keys()]);
    expect([...middleBatchEventKeys].every((k) => durableKeys.has(`sid:${k}`))).toBe(true);
  });

  it("VARIANT: a LEASE-LOSS interruption (not a deadline) obeys the identical no-stranding invariant", async () => {
    const repo = new FakeRepo();
    repo.fillsByEventKey.set("OLD_ANCHOR", { id: "fill-anchor", row: { eventKey: "OLD_ANCHOR", wallet: WALLET.toLowerCase() } as RawFillRow, downstreamStatus: "COMPLETE" });
    const middleBatchEventKeys = new Set(Array.from({ length: PAGE_SIZE }, (_, i) => `MIDDLE_BATCH-${i}`));
    let wave = 1;
    const network = wavesNetwork(middleBatchEventKeys, () => wave);
    const base = 1_700_000_500_000;

    // Lease reports valid for the first checkpoint call (before page 0), lost on the second
    // (before page 1) -- interrupting after exactly one page, same shape as the deadline
    // variant, but via the P1-G lease-checkpoint path instead.
    let leaseCalls = 0;
    const checkpointLease: LeaseCheckpoint = async () => {
      leaseCalls += 1;
      return leaseCalls === 1;
    };
    const first = await pollSportsShadowWallet(
      WALLET,
      0,
      { repo, now: () => base, checkpointLease, fetchSourceMarketMetadata: vi.fn(async () => ELIGIBLE_METADATA) as unknown as WalletPollDeps["fetchSourceMarketMetadata"], network },
    );
    expect(first.leaseLost).toBe(true);
    expect(first.newRows).toBe(0); // same invariant: an interrupted scan persists nothing
    expect(repo.fillsByEventKey.size).toBe(1);

    wave = 2;
    const second = await pollSportsShadowWallet(
      WALLET,
      0,
      { repo, now: () => base + 10_000, fetchSourceMarketMetadata: vi.fn(async () => ELIGIBLE_METADATA) as unknown as WalletPollDeps["fetchSourceMarketMetadata"], network },
      base + 10_000 + 999_999,
    );
    expect(second.leaseLost).toBe(false);
    const durableKeys = new Set([...repo.fillsByEventKey.keys()]);
    expect([...middleBatchEventKeys].every((k) => durableKeys.has(`sid:${k}`))).toBe(true);
  });

  it("VARIANT: a >1-page shift (two full pages of new trades arrive between polls) still never strands MIDDLE_BATCH", async () => {
    const repo = new FakeRepo();
    repo.fillsByEventKey.set("OLD_ANCHOR", { id: "fill-anchor", row: { eventKey: "OLD_ANCHOR", wallet: WALLET.toLowerCase() } as RawFillRow, downstreamStatus: "COMPLETE" });
    const middleBatchEventKeys = new Set(Array.from({ length: PAGE_SIZE }, (_, i) => `MIDDLE_BATCH-${i}`));

    let wave = 1;
    const network: SourcePollNetworkDeps = {
      fetchImpl: (async (url: string | URL) => {
        const offset = Number(new URL(String(url)).searchParams.get("offset"));
        let rows: unknown[];
        if (offset === 0 && wave === 1) {
          rows = Array.from({ length: PAGE_SIZE }, (_, i) => trade({ id: `NEW_BATCH_1-${i}`, transactionHash: `0xtx-nb1-${i}` }));
        } else if (wave === 2 && (offset === 0 || offset === PAGE_SIZE)) {
          // TWO full pages of brand-new trades now sit ahead of NEW_BATCH_1.
          rows = Array.from({ length: PAGE_SIZE }, (_, i) => trade({ id: `NEWER-${offset}-${i}`, transactionHash: `0xtx-newer-${offset}-${i}` }));
        } else if (wave === 2 && offset === PAGE_SIZE * 2) {
          // NEW_BATCH_1 has shifted from page 0 to page 2 -- a >1-page shift.
          rows = Array.from({ length: PAGE_SIZE }, (_, i) => trade({ id: `NEW_BATCH_1-${i}`, transactionHash: `0xtx-nb1-${i}` }));
        } else if (offset === PAGE_SIZE * 3) {
          rows = Array.from(middleBatchEventKeys).map((id) => trade({ id, transactionHash: `0xtx-${id}` }));
        } else {
          rows = [];
        }
        return new Response(JSON.stringify(rows), { status: 200, headers: { "content-type": "application/json" } });
      }) as typeof fetch,
      reserveRequestSlot: async () => 0,
      getHostCooldown: async () => ({ blocked: false, reason: null }),
      recordHostRateLimit: async () => {},
    };
    const base = 1_700_000_500_000;

    const firstNow = sequentialClock([base, base, base + 999_999]);
    const first = await pollSportsShadowWallet(
      WALLET,
      0,
      { repo, now: firstNow, fetchSourceMarketMetadata: vi.fn(async () => ELIGIBLE_METADATA) as unknown as WalletPollDeps["fetchSourceMarketMetadata"], network },
      base + 500,
    );
    expect(first.newRows).toBe(0);
    expect(repo.fillsByEventKey.size).toBe(1);

    wave = 2;
    const second = await pollSportsShadowWallet(
      WALLET,
      0,
      { repo, now: () => base + 10_000, fetchSourceMarketMetadata: vi.fn(async () => ELIGIBLE_METADATA) as unknown as WalletPollDeps["fetchSourceMarketMetadata"], network },
      base + 10_000 + 999_999,
    );
    expect(second.error).toBeNull();
    const durableKeys = new Set([...repo.fillsByEventKey.keys()]);
    expect([...middleBatchEventKeys].every((k) => durableKeys.has(`sid:${k}`))).toBe(true);
    expect(durableKeys.has("sid:NEW_BATCH_1-0")).toBe(true);
  });
});

describe("Task 13F: Phase 2 (pending-fill/metadata resolution) deadline bound, and default-behavior preservation", () => {
  it("Task 13G (Codex re-review round 5, P1): a degraded-reconciliation FAILURE aborts ALL persistence this poll, not just the degraded half", async () => {
    const repo = new FakeRepo();
    repo.throwOnCountDurableOrdinal = new Error("reconciliation db failure");
    const reliableRow = trade({ id: "native-reliable" }); // reliable identity (has a native id)
    const degradedRow = trade({ id: undefined }); // falls back to tx_hash_ordinal
    const network = makeNetworkDeps({ 0: [reliableRow, degradedRow] });
    const { deps } = makeDeps({ repo, network });
    const result = await pollSportsShadowWallet(WALLET, 0, deps);
    expect(result.error).toContain("countDurableOrdinalFills failed");
    // Neither the reliable nor the degraded row was persisted -- persisting the reliable
    // one alone would let a later poll's overlap check treat this whole page as covered,
    // permanently stranding the un-reconciled degraded row it also contained.
    expect(result.newRows).toBe(0);
    expect(repo.fillsByEventKey.size).toBe(0);
    expect(result.backlogTruncated).toBe(true);
  });

  it("Task 13G (Codex re-review round 5, P1): the deadline is re-checked immediately after a WRITE-SIDE checkpointLease succeeds, before the mutating episode write itself", async () => {
    const repo = new FakeRepo();
    await repo.insertRawFill({
      wallet: WALLET,
      eventKey: "seeded-new-episode",
      conditionId: "0xcond",
      asset: "0xasset",
      side: "BUY",
      sourceTs: 1_700_000_000,
      shares: 1,
      price: 0.5,
      identityBasis: "source_id",
      identityDegraded: false,
      raw: {},
    } as unknown as Parameters<FakeRepo["insertRawFill"]>[0]);
    const base = 1_700_000_500_000;
    // Flips to "exceeded" only once checkpointLease has been called 4 times: (1) Phase 1's
    // single (empty-page) fetch attempt, (2) Phase 2's initial lease guard, (3) the
    // pending-fill loop's top-of-iteration check, (4) the NEW_EPISODE mutation site's own
    // checkpoint -- isolating specifically the recheck immediately AFTER that 4th call
    // succeeds, before insertEpisodeAtomic itself.
    let checkpointCalls = 0;
    const checkpointLease: LeaseCheckpoint = async () => {
      checkpointCalls += 1;
      return true;
    };
    const now = () => (checkpointCalls >= 4 ? base + 999_999 : base);
    const { deps } = makeDeps({
      repo,
      now,
      checkpointLease,
      fetchSourceMarketMetadata: vi.fn(async () => ELIGIBLE_METADATA) as unknown as WalletPollDeps["fetchSourceMarketMetadata"],
      network: makeNetworkDeps({ 0: [] }),
    });
    const result = await pollSportsShadowWallet(WALLET, 0, deps, base + 500);
    expect(repo.episodesById.size).toBe(0); // insertEpisodeAtomic never happened
    expect(result.newSignals).toHaveLength(0);
    const seededFill = repo.fillsByEventKey.get("seeded-new-episode")!;
    expect(seededFill.downstreamStatus).toBe("PENDING"); // safely retryable, never lost
  });

  it("Task 13G (Codex re-review round 6, P1): Phase 2 is skipped ENTIRELY (no lease-renewal RPC, no pending-fill query) if the deadline has already passed by the time Phase 1 finishes", async () => {
    const repo = new FakeRepo();
    await repo.insertRawFill({
      wallet: WALLET,
      eventKey: "seeded",
      conditionId: "0xcond",
      asset: "0xasset",
      side: "BUY",
      sourceTs: 1_700_000_000,
      shares: 1,
      price: 0.5,
      identityBasis: "source_id",
      identityDegraded: false,
      raw: {},
    } as unknown as Parameters<FakeRepo["insertRawFill"]>[0]);
    let checkpointCalls = 0;
    const checkpointLease: LeaseCheckpoint = async () => {
      checkpointCalls += 1;
      return true;
    };
    const base = 1_700_000_500_000;
    // Deadline already exceeded by the time Phase 1's own single (empty-page) fetch
    // attempt finishes -- Phase 2 must never even call checkpointLease.
    const now = () => base + 999_999;
    const { deps } = makeDeps({ repo, now, checkpointLease, network: makeNetworkDeps({ 0: [] }) });
    const result = await pollSportsShadowWallet(WALLET, 0, deps, base);
    expect(result.leaseLost).toBe(false); // a pure deadline stop, not lease loss
    expect(checkpointCalls).toBe(0); // Phase 2's own lease-renewal RPC never even started
    expect(result.newSignals).toHaveLength(0);
    const seededFill = repo.fillsByEventKey.get("seeded")!;
    expect(seededFill.downstreamStatus).toBe("PENDING");
  });

  it("Task 13G (Codex re-review round 6, P1): the deadline is re-checked immediately after metadata resolution, before a terminal-marker write, even though the top-of-iteration check already passed", async () => {
    const repo = new FakeRepo();
    await repo.insertRawFill({
      wallet: WALLET,
      eventKey: "seeded-ineligible",
      conditionId: "0xcond",
      asset: "0xasset",
      side: "BUY",
      sourceTs: 1_700_000_000,
      shares: 1,
      price: 0.5,
      identityBasis: "source_id",
      identityDegraded: false,
      raw: {},
    } as unknown as Parameters<FakeRepo["insertRawFill"]>[0]);
    const base = 1_700_000_500_000;
    // Flips to "exceeded" only once fetchSourceMarketMetadata has actually been awaited,
    // isolating the recheck immediately AFTER metadata resolution rather than any of the
    // earlier (already-covered) checks.
    let metadataResolved = false;
    const fetchSourceMarketMetadata = vi.fn(async () => {
      metadataResolved = true;
      return { ...ELIGIBLE_METADATA, status: "INELIGIBLE" as const, ineligibleReason: "test" };
    });
    const now = () => (metadataResolved ? base + 999_999 : base);
    const { deps } = makeDeps({
      repo,
      now,
      fetchSourceMarketMetadata: fetchSourceMarketMetadata as unknown as WalletPollDeps["fetchSourceMarketMetadata"],
      network: makeNetworkDeps({ 0: [] }),
    });
    const result = await pollSportsShadowWallet(WALLET, 0, deps, base + 500);
    expect(result.ineligibleRows).toBe(0); // markFillTerminal(INELIGIBLE) never happened
    const seededFill = repo.fillsByEventKey.get("seeded-ineligible")!;
    expect(seededFill.downstreamStatus).toBe("PENDING"); // safely retryable, never lost
  });

  it("Phase 2: a deadline reached mid-pending-fill-processing stops resolving further fills, but unprocessed ones simply stay PENDING (Task 12D/P1-A's existing retry contract, zero new mechanism)", async () => {
    const repo = new FakeRepo();
    // Seed 5 already-raw-persisted PENDING fills directly (skip Phase 1 entirely).
    for (let i = 0; i < 5; i += 1) {
      await repo.insertRawFill({
        wallet: WALLET,
        eventKey: `seeded-${i}`,
        conditionId: "0xcond",
        asset: "0xasset",
        side: "BUY",
        sourceTs: 1_700_000_000 + i,
        shares: 1,
        price: 0.5,
        identityBasis: "source_id",
        identityDegraded: false,
        raw: {},
      } as unknown as Parameters<FakeRepo["insertRawFill"]>[0]);
    }
    let metadataCalls = 0;
    const base = 1_700_000_500_000;
    // detectedAtMs + hasAnyFillsForWallet path uses `now` too, but the critical checks are
    // the per-fill deadline checks in Phase 2 -- give it enough budget to pass Phase 1
    // (no pages to fetch here) then run out partway through the 5 pending fills.
    let call = 0;
    const now = () => {
      call += 1;
      return call <= 2 ? base : base + 999_999; // first couple of calls "before deadline", rest "after"
    };
    const result = await pollSportsShadowWallet(WALLET, 0, {
      repo,
      now,
      fetchSourceMarketMetadata: vi.fn(async () => {
        metadataCalls += 1;
        return ELIGIBLE_METADATA;
      }) as unknown as WalletPollDeps["fetchSourceMarketMetadata"],
      network: fullPageFetcher([]),
    }, base + 1);
    expect(metadataCalls).toBeLessThan(5); // stopped before processing every pending fill
    const stillPending = [...repo.fillsByEventKey.values()].filter((f) => f.downstreamStatus === "PENDING");
    expect(stillPending.length).toBeGreaterThan(0); // unprocessed fills remain safely PENDING, not lost or fabricated as terminal
  });

  it("omitting deadlineAtMs entirely preserves the exact prior unbounded-by-time behavior (default is Number.POSITIVE_INFINITY -- existing callers/tests are completely unaffected)", async () => {
    const repo = new FakeRepo();
    const result = await pollSportsShadowWallet(WALLET, 0, {
      repo,
      now: () => 1_700_000_500_000,
      fetchSourceMarketMetadata: vi.fn(async () => ELIGIBLE_METADATA) as unknown as WalletPollDeps["fetchSourceMarketMetadata"],
      network: makeNetworkDeps({ 0: [] }),
    });
    expect(result.error).toBeNull();
  });
});

describe("Task 13E, C: the default network path (no fetchImpl override) uses the Cloudflare-Workers-safe runtimeFetch adapter, not a bare detached `fetch` reference", () => {
  function installThisSensitiveGlobalFetch(): () => void {
    const original = globalThis.fetch;
    function brandedFetch(this: unknown): ReturnType<typeof fetch> {
      if (this !== globalThis) {
        throw new TypeError("Illegal invocation: function called with incorrect `this` reference.");
      }
      return Promise.resolve(new Response("[]", { status: 200, headers: { "content-type": "application/json" } }));
    }
    globalThis.fetch = brandedFetch as typeof fetch;
    return () => {
      globalThis.fetch = original;
    };
  }

  it("pollSportsShadowWallet completes without an Illegal-invocation failure when no network.fetchImpl override is supplied at all", async () => {
    const restore = installThisSensitiveGlobalFetch();
    try {
      const repo = new FakeRepo();
      const result = await pollSportsShadowWallet(WALLET, 0, {
        repo,
        now: () => 1_700_000_500_000,
        network: {
          // Deliberately no `fetchImpl` here -- must fall through to the module's own
          // defaultNetworkDeps.fetchImpl, which Task 13E fixed to be runtimeFetch.
          reserveRequestSlot: async () => 0,
          getHostCooldown: async () => ({ blocked: false, reason: null }),
          recordHostRateLimit: async () => {},
        } as Partial<SourcePollNetworkDeps> as SourcePollNetworkDeps,
      });
      expect(result.pagesFetched).toBeGreaterThan(0); // the branded fetch really was called and returned successfully
      expect(result.newRows).toBe(0); // empty page -- no fabricated evidence
    } finally {
      restore();
    }
  });
});

/* ======================================================================
 * TASK 13G, Section 8: BOOTSTRAP PERFORMANCE -- synthetic versions of the
 * three approved active-wallet trading profiles (no public network, fully
 * deterministic). Proves the forward-only bootstrap redesign (Task 13G /
 * P1-Q) stays within a bounded, small number of network calls on a wallet's
 * very first poll regardless of how much REAL history that wallet actually
 * has, how bursty its recent trading is, provider pacing delays, or an
 * occasional request timeout -- because bootstrap never looks past page 0 by
 * design (BOOTSTRAP_MAX_PAGES=1), unlike the old up-to-41-page historical walk.
 * ====================================================================== */
describe("Task 13G, Section 8: bootstrap performance under realistic wallet profiles", () => {
  // Task 13G / P1-Q (Codex re-review): bootstrap's page count is now GO-LIVE-AWARE, not a
  // fixed constant -- it stops as soon as a page proves the go-live boundary has been
  // crossed. Each page's `n` rows get DECREASING timestamps (row 0 = newest), spanning
  // `n` seconds, so a `goLiveAtMs` chosen within or below that span determines whether
  // page 0 alone crosses it.
  function profilePage(profile: "moderate" | "deep" | "bursty", offset: number): Record<string, unknown>[] {
    const counts: Record<typeof profile, number> = { moderate: 40, deep: PAGE_SIZE, bursty: PAGE_SIZE };
    const n = offset === 0 ? counts[profile] : offset === PAGE_SIZE && profile === "bursty" ? 30 : 0;
    const pageBaseTs = 1_700_010_000 - offset; // each further-back page is strictly older
    return Array.from({ length: n }, (_, i) =>
      trade({
        id: `${profile}-${offset}-${i}`,
        transactionHash: `0x${profile}-${offset}-${i}`,
        side: i % 5 === 0 ? "SELL" : "BUY",
        timestamp: pageBaseTs - i,
      }),
    );
  }

  it("wallet profile 'moderate': a naturally short trading history needs exactly ONE trades-page request (short-page natural end)", async () => {
    let calls = 0;
    const { repo, deps } = makeDeps({
      network: {
        fetchImpl: (async (url: string | URL) => {
          calls += 1;
          const offset = Number(new URL(String(url)).searchParams.get("offset"));
          return new Response(JSON.stringify(profilePage("moderate", offset)), { status: 200, headers: { "content-type": "application/json" } });
        }) as typeof fetch,
        reserveRequestSlot: async () => 0,
        getHostCooldown: async () => ({ blocked: false, reason: null }),
        recordHostRateLimit: async () => {},
      },
    });
    const result = await pollSportsShadowWallet(WALLET, 0, deps); // goLiveAtMs=0 -- irrelevant here, page 0 is short regardless
    expect(calls).toBe(1);
    expect(result.isBootstrap).toBe(true);
    expect(result.error).toBeNull();
    expect(result.backlogTruncated).toBe(false);
    expect(repo.fillsByEventKey.size).toBeGreaterThan(0);
  });

  it("wallet profile 'deep': a long-established wallet with only a handful of trades since go-live needs exactly ONE trades-page request (crosses the go-live boundary within page 0)", async () => {
    let calls = 0;
    const { repo, deps } = makeDeps({
      network: {
        fetchImpl: (async (url: string | URL) => {
          calls += 1;
          const offset = Number(new URL(String(url)).searchParams.get("offset"));
          return new Response(JSON.stringify(profilePage("deep", offset)), { status: 200, headers: { "content-type": "application/json" } });
        }) as typeof fetch,
        reserveRequestSlot: async () => 0,
        getHostCooldown: async () => ({ blocked: false, reason: null }),
        recordHostRateLimit: async () => {},
      },
    });
    // Go-live set 10s into page 0's 250s span -- only the newest ~10 rows are post-go-live,
    // the remaining ~240 (deep pre-existing history) are pre-go-live, so page 0 alone
    // already proves the boundary is crossed.
    const goLiveAtMs = (1_700_010_000 - 10) * 1000;
    const result = await pollSportsShadowWallet(WALLET, goLiveAtMs, deps);
    expect(calls).toBe(1); // the wallet's deep PRE-go-live history is correctly never walked
    expect(result.isBootstrap).toBe(true);
    expect(result.error).toBeNull();
    expect(result.backlogTruncated).toBe(false);
    expect(repo.fillsByEventKey.size).toBeGreaterThan(0);
  });

  it("wallet profile 'bursty': more than PAGE_SIZE trades since go-live correctly walks a SECOND page rather than silently stranding them (the exact scenario Codex's re-review flagged)", async () => {
    let calls = 0;
    const { repo, deps } = makeDeps({
      network: {
        fetchImpl: (async (url: string | URL) => {
          calls += 1;
          const offset = Number(new URL(String(url)).searchParams.get("offset"));
          return new Response(JSON.stringify(profilePage("bursty", offset)), { status: 200, headers: { "content-type": "application/json" } });
        }) as typeof fetch,
        reserveRequestSlot: async () => 0,
        getHostCooldown: async () => ({ blocked: false, reason: null }),
        recordHostRateLimit: async () => {},
      },
    });
    // Go-live set well before page 0's oldest row (1_700_010_000 - 249) -- every one of
    // page 0's 250 rows is post-go-live, so a second page is genuinely required to prove
    // the boundary has been crossed.
    const goLiveAtMs = (1_700_010_000 - 400) * 1000;
    const result = await pollSportsShadowWallet(WALLET, goLiveAtMs, deps);
    expect(calls).toBe(2); // correctly continues past page 0 -- no eligible fill is stranded
    expect(result.isBootstrap).toBe(true);
    expect(result.error).toBeNull();
    expect(result.backlogTruncated).toBe(false); // genuinely crossed the boundary, not truncated
    expect(repo.fillsByEventKey.size).toBe(PAGE_SIZE + 30); // both pages' rows persisted
  });

  it("bootstrap under 500ms provider pacing (reserveRequestSlot) completes with exactly one paced request in the common (go-live-crossed-within-page-0) case -- pacing cost does not multiply across pages it doesn't need", async () => {
    let calls = 0;
    const { deps } = makeDeps({
      network: {
        fetchImpl: (async (url: string | URL) => {
          calls += 1;
          const offset = Number(new URL(String(url)).searchParams.get("offset"));
          return new Response(JSON.stringify(profilePage("deep", offset)), { status: 200, headers: { "content-type": "application/json" } });
        }) as typeof fetch,
        reserveRequestSlot: async () => 500, // simulated 500ms pacing wait before every request
        getHostCooldown: async () => ({ blocked: false, reason: null }),
        recordHostRateLimit: async () => {},
      },
    });
    const goLiveAtMs = (1_700_010_000 - 10) * 1000;
    const start = Date.now();
    const result = await pollSportsShadowWallet(WALLET, goLiveAtMs, deps);
    const elapsedMs = Date.now() - start;
    expect(calls).toBe(1);
    expect(result.error).toBeNull();
    // One page's pacing wait (~500ms), not 41 pages' worth (~20s) -- generous upper bound
    // to stay non-flaky under CI scheduling jitter while still catching a regression back
    // to an unconditional multi-page bootstrap walk.
    expect(elapsedMs).toBeLessThan(5_000);
  });

  it("an occasional request failure/timeout on bootstrap's single page fails closed (no rows persisted), never throws out of pollSportsShadowWallet, and is safely retried as bootstrap again next time", async () => {
    // Represents pacedFetchTradesPage's own REQUEST_TIMEOUT_MS abort surfacing as a
    // rejected fetch -- exercised directly (not via a real 12s wait) since
    // pollSportsShadowWallet's own contract ("never throws", module doc comment) and
    // fail-closed persistence behavior do not depend on which specific network failure
    // triggered the rejection.
    const { repo, deps } = makeDeps({
      network: {
        fetchImpl: (async () => {
          throw new Error("The operation was aborted (simulated 12s request timeout)");
        }) as typeof fetch,
        reserveRequestSlot: async () => 0,
        getHostCooldown: async () => ({ blocked: false, reason: null }),
        recordHostRateLimit: async () => {},
      },
    });
    const result = await pollSportsShadowWallet(WALLET, 0, deps);
    expect(result.error).toContain("trade page fetch failed");
    // A reported error (not backlogTruncated) is this poll's signal to retry -- Task 11's
    // orchestration layer retries on ANY non-null result.error regardless of
    // backlogTruncated. Either way, nothing was persisted, so retrying as bootstrap again
    // next poll is fully safe and idempotent.
    expect(result.newRows).toBe(0);
    expect(repo.fillsByEventKey.size).toBe(0);
  });
});
