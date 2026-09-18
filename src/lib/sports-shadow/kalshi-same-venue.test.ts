/**
 * SAME-VENUE (Kalshi -> Kalshi) PAPER pipeline tests — source-independent.
 *
 * Uses an in-memory repository that enforces the SAME uniqueness invariants the migration
 * enforces (event_key UNIQUE, (trader_id, source_trade_id) UNIQUE, PENDING->PROCESSING
 * claim, UNIQUE (source_event_id, tier)), so restart/duplicate-worker behaviour is proven
 * against the durable contract rather than an in-memory Set. No fabricated production
 * transport: the only events in these tests are explicit test fixtures.
 */

import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { SPORTS_SHADOW_NOTIONALS_USD } from "./depth-walk";
import type { KalshiContractSide, KalshiTraderQualification, KalshiTraderSourceEvent, NormalizedKalshiSourceTrade } from "./kalshi-source";
import {
  admitSameVenueSourceEvent,
  assertSameVenueRoute,
  processPendingSameVenueEvents,
  runKalshiSourceIngestCycle,
  SAME_VENUE_ROUTE,
  type AdmittedSameVenueEvent,
  type SameVenueBook,
  type SameVenueEventStatus,
  type SameVenuePaperFillInput,
  type SameVenueRepository,
} from "./kalshi-same-venue";

const TICKER = "KXMLBGAME-26AUG25CHCCIN-CHC";
const TRADER = "kalshi-trader-1";

type StoredEvent = AdmittedSameVenueEvent & { status: SameVenueEventStatus; statusReason: string | null; episodeKey: string | null; createdSeq: number };

class MemoryRepo implements SameVenueRepository {
  events: StoredEvent[] = [];
  fills: SameVenuePaperFillInput[] = [];
  positions = new Map<string, { contractsOpen: number; avgEntryPrice: number | null; realized: number; status: "OPEN" | "CLOSED" }>();
  qualifications = new Map<string, KalshiTraderQualification>();
  private seq = 0;

  private posKey(traderId: string, ticker: string, side: KalshiContractSide, tier: number): string {
    return `${traderId}|${ticker}|${side}|${tier}`;
  }

  approve(traderId: string): void {
    this.qualifications.set(traderId, { traderId, approvedForPaperCopy: true });
  }

  async getQualification(traderId: string): Promise<KalshiTraderQualification | null> {
    return this.qualifications.get(traderId) ?? null;
  }

  async admitEvent(trade: NormalizedKalshiSourceTrade, detectedAtMs: number): Promise<{ admitted: boolean; duplicate: boolean; id: string | null }> {
    const existing = this.events.find((e) => e.eventKey === trade.eventKey || (e.traderId === trade.traderId && e.sourceTradeId === trade.sourceTradeId));
    if (existing) return { admitted: false, duplicate: true, id: existing.id };
    this.seq += 1;
    const row: StoredEvent = {
      id: `evt-${this.seq}`,
      route: trade.route,
      eventKey: trade.eventKey,
      traderId: trade.traderId,
      sourceTradeId: trade.sourceTradeId,
      marketTicker: trade.marketTicker,
      contractSide: trade.contractSide,
      action: trade.action,
      quantity: trade.quantity,
      sourcePrice: trade.price,
      sourceTs: trade.sourceTs,
      detectedAtMs,
      status: "PENDING",
      statusReason: null,
      episodeKey: null,
      createdSeq: this.seq,
    };
    this.events.push(row);
    return { admitted: true, duplicate: false, id: row.id };
  }

  async claimPendingEvents(_workerId: string, limit: number): Promise<AdmittedSameVenueEvent[]> {
    const pending = this.events
      .filter((e) => e.status === "PENDING")
      .sort((a, b) => a.sourceTs - b.sourceTs || a.createdSeq - b.createdSeq)
      .slice(0, limit);
    for (const row of pending) row.status = "PROCESSING";
    return pending.map((row) => ({ ...row }));
  }

  async listPositionHistory(traderId: string, ticker: string, side: KalshiContractSide): Promise<AdmittedSameVenueEvent[]> {
    return this.events
      .filter((e) => e.traderId === traderId && e.marketTicker === ticker && e.contractSide === side)
      .sort((a, b) => a.sourceTs - b.sourceTs || a.createdSeq - b.createdSeq)
      .map((row) => ({ ...row }));
  }

  async getOpenPosition(traderId: string, ticker: string, side: KalshiContractSide, tier: number) {
    const pos = this.positions.get(this.posKey(traderId, ticker, side, tier));
    if (!pos || pos.contractsOpen <= 0) return null;
    return { contractsOpen: pos.contractsOpen, avgEntryPrice: pos.avgEntryPrice };
  }

  async finalizePaperFill(input: SameVenuePaperFillInput): Promise<boolean> {
    const dup = this.fills.some((f) => f.sourceEventId === input.sourceEventId && f.notionalTierUsd === input.notionalTierUsd);
    if (dup) return false; // mirrors UNIQUE (source_event_id, notional_tier_usd)
    this.fills.push(input);
    if (input.contracts <= 0) return true;
    const key = this.posKey(input.traderId, input.marketTicker, input.contractSide, input.notionalTierUsd);
    const pos = this.positions.get(key) ?? { contractsOpen: 0, avgEntryPrice: null, realized: 0, status: "OPEN" as const };
    if (input.action === "EXIT") {
      const sell = Math.min(input.contracts, pos.contractsOpen);
      pos.realized += ((input.vwap ?? 0) - (pos.avgEntryPrice ?? 0)) * sell - (input.feeUsd ?? 0);
      pos.contractsOpen -= sell;
      pos.status = pos.contractsOpen <= 0 ? "CLOSED" : "OPEN";
    } else {
      const total = pos.contractsOpen + input.contracts;
      pos.avgEntryPrice = total > 0 ? ((pos.avgEntryPrice ?? 0) * pos.contractsOpen + (input.vwap ?? 0) * input.contracts) / total : pos.avgEntryPrice;
      pos.contractsOpen = total;
      pos.status = "OPEN";
    }
    this.positions.set(key, pos);
    return true;
  }

  async markEvent(eventId: string, status: SameVenueEventStatus, statusReason: string | null, episodeKey: string | null): Promise<void> {
    const row = this.events.find((e) => e.id === eventId);
    if (row) {
      row.status = status;
      row.statusReason = statusReason;
      row.episodeKey = episodeKey;
    }
  }
}

const BOOK: SameVenueBook = {
  observedAtMs: 1_700_000_000_000,
  staleReason: null,
  askLevels: [
    { price: 0.55, size: 500 },
    { price: 0.56, size: 500 },
  ],
  bidLevels: [
    { price: 0.54, size: 500 },
    { price: 0.53, size: 500 },
  ],
};

function rawEvent(overrides: Partial<KalshiTraderSourceEvent> = {}): KalshiTraderSourceEvent {
  return {
    traderId: TRADER,
    sourceTradeId: "t-1",
    marketTicker: TICKER,
    contractSide: "YES",
    action: "BUY",
    quantity: 100,
    priceCents: 55,
    sourceTsSeconds: 1_700_000_000,
    ...overrides,
  };
}

async function fetchBook(input: { ticker: string; side: KalshiContractSide }): Promise<SameVenueBook> {
  seenTickers.push(input.ticker);
  seenSides.push(input.side);
  return BOOK;
}
let seenTickers: string[] = [];
let seenSides: KalshiContractSide[] = [];

async function setupWithBuy(repo: MemoryRepo, detectedAtMs = 1_700_000_010_000): Promise<void> {
  repo.approve(TRADER);
  const admitted = await admitSameVenueSourceEvent(rawEvent(), { repo, now: () => detectedAtMs });
  expect(admitted.ok).toBe(true);
}

describe("same-venue Kalshi paper pipeline (source-independent)", () => {
  it("1. durable duplicate admission is idempotent and never creates a second row", async () => {
    const repo = new MemoryRepo();
    repo.approve(TRADER);
    const first = await admitSameVenueSourceEvent(rawEvent(), { repo, now: () => 1_700_000_010_000 });
    const second = await admitSameVenueSourceEvent(rawEvent(), { repo, now: () => 1_700_000_020_000 });
    expect(first.ok && first.duplicate).toBe(false);
    expect(second.ok && second.duplicate).toBe(true);
    expect(repo.events).toHaveLength(1);
  });

  it("2. a restart/re-read cannot create a second paper execution", async () => {
    const repo = new MemoryRepo();
    await setupWithBuy(repo);
    const first = await processPendingSameVenueEvents({ repo, fetchBook, workerId: "w1" });
    const fillsAfterFirst = repo.fills.length;
    // Simulated restart: re-claim (nothing is PENDING) AND a forced replay of the same row.
    const second = await processPendingSameVenueEvents({ repo, fetchBook, workerId: "w2" });
    const replay = await repo.finalizePaperFill({ ...repo.fills[0]! });
    expect(first.executed).toBe(1);
    expect(second.claimed).toBe(0);
    expect(replay).toBe(false);
    expect(repo.fills).toHaveLength(fillsAfterFirst);
  });

  it("3. SAME_VENUE_KALSHI rows bypass the resolver / cross-venue matcher", async () => {
    const repo = new MemoryRepo();
    await setupWithBuy(repo);
    await processPendingSameVenueEvents({ repo, fetchBook, workerId: "w1" });
    expect(assertSameVenueRoute({ route: SAME_VENUE_ROUTE })).toBe(true);
    expect(assertSameVenueRoute({ route: "CROSS_VENUE" })).toBe(false);
    // Static proof: the pipeline module imports no cross-venue module.
    const src = readFileSync("src/lib/sports-shadow/kalshi-same-venue.ts", "utf8");
    for (const forbidden of ["./resolver", "./pmus", "./source-metadata", "./classification", "./eligibility", "./sport-registry"]) {
      expect(src.includes(`from "${forbidden}`)).toBe(false);
    }
  });

  it("4. exact ticker and YES/NO side survive persistence and routing", async () => {
    const repo = new MemoryRepo();
    seenTickers = [];
    seenSides = [];
    repo.approve(TRADER);
    await admitSameVenueSourceEvent(rawEvent({ contractSide: "NO", sourceTradeId: "t-no" }), { repo, now: () => 1_700_000_010_000 });
    const outcome = await processPendingSameVenueEvents({ repo, fetchBook, workerId: "w1" });
    expect(outcome.targetedTickers).toEqual([TICKER]);
    expect(seenTickers).toEqual([TICKER]);
    expect(seenSides).toEqual(["NO"]);
    expect(repo.fills.every((f) => f.marketTicker === TICKER && f.contractSide === "NO")).toBe(true);
  });

  it("5. BUY creates a paper ENTRY intent on every notional tier", async () => {
    const repo = new MemoryRepo();
    await setupWithBuy(repo);
    await processPendingSameVenueEvents({ repo, fetchBook, workerId: "w1" });
    expect(repo.fills).toHaveLength(SPORTS_SHADOW_NOTIONALS_USD.length);
    expect(repo.fills.every((f) => f.action === "ENTRY" && f.contracts > 0)).toBe(true);
  });

  it("6. a second BUY inside the window follows ADD/DCA", async () => {
    const repo = new MemoryRepo();
    await setupWithBuy(repo);
    await processPendingSameVenueEvents({ repo, fetchBook, workerId: "w1" });
    await admitSameVenueSourceEvent(rawEvent({ sourceTradeId: "t-2", sourceTsSeconds: 1_700_000_600 }), { repo, now: () => 1_700_000_620_000 });
    await processPendingSameVenueEvents({ repo, fetchBook, workerId: "w1" });
    const adds = repo.fills.filter((f) => f.action === "ADD");
    expect(adds).toHaveLength(SPORTS_SHADOW_NOTIONALS_USD.length);
  });

  it("7. a partial SELL follows a proportional EXIT", async () => {
    const repo = new MemoryRepo();
    await setupWithBuy(repo);
    await processPendingSameVenueEvents({ repo, fetchBook, workerId: "w1" });
    const openBefore = await repo.getOpenPosition(TRADER, TICKER, "YES", 5);
    await admitSameVenueSourceEvent(rawEvent({ sourceTradeId: "t-sell", action: "SELL", quantity: 50, sourceTsSeconds: 1_700_000_300 }), {
      repo,
      now: () => 1_700_000_320_000,
    });
    await processPendingSameVenueEvents({ repo, fetchBook, workerId: "w1" });
    const exits = repo.fills.filter((f) => f.action === "EXIT");
    expect(exits.length).toBeGreaterThan(0);
    const after = await repo.getOpenPosition(TRADER, TICKER, "YES", 5);
    expect(openBefore!.contractsOpen).toBeGreaterThan(0);
    expect(after!.contractsOpen).toBeCloseTo(openBefore!.contractsOpen * 0.5, 6);
  });

  it("8. a full SELL closes the paper lifecycle", async () => {
    const repo = new MemoryRepo();
    await setupWithBuy(repo);
    await processPendingSameVenueEvents({ repo, fetchBook, workerId: "w1" });
    await admitSameVenueSourceEvent(rawEvent({ sourceTradeId: "t-full", action: "SELL", quantity: 100, sourceTsSeconds: 1_700_000_400 }), {
      repo,
      now: () => 1_700_000_420_000,
    });
    await processPendingSameVenueEvents({ repo, fetchBook, workerId: "w1" });
    expect(await repo.getOpenPosition(TRADER, TICKER, "YES", 5)).toBeNull();
    expect([...repo.positions.values()].every((p) => p.status === "CLOSED")).toBe(true);
  });

  it("9. an unapproved trader fails closed before any paper execution", async () => {
    const repo = new MemoryRepo();
    const result = await admitSameVenueSourceEvent(rawEvent(), { repo, now: () => 1 });
    expect(result.ok).toBe(false);
    expect(!result.ok && result.reasonCode).toBe("REJECT_TRADER_NOT_QUALIFIED");
    expect(repo.events).toHaveLength(0);
    const outcome = await processPendingSameVenueEvents({ repo, fetchBook, workerId: "w1" });
    expect(outcome.claimed).toBe(0);
    expect(repo.fills).toHaveLength(0);
  });

  it("10. malformed/incomplete events fail closed and are never persisted", async () => {
    const repo = new MemoryRepo();
    repo.approve(TRADER);
    const cases: Partial<KalshiTraderSourceEvent>[] = [
      { marketTicker: "not a ticker" },
      { contractSide: "yes" },
      { action: "OPEN" },
      { quantity: 0 },
      { priceCents: 0 },
      { sourceTsSeconds: 0 },
      { traderId: "" },
      { sourceTradeId: undefined },
    ];
    for (const patch of cases) {
      const result = await admitSameVenueSourceEvent(rawEvent(patch), { repo, now: () => 1 });
      expect(result.ok).toBe(false);
    }
    expect(repo.events).toHaveLength(0);
  });

  it("11. source_ts and detected_at stay distinct and are never substituted", async () => {
    const repo = new MemoryRepo();
    repo.approve(TRADER);
    await admitSameVenueSourceEvent(rawEvent(), { repo, now: () => 1_700_000_099_000 });
    const row = repo.events[0]!;
    expect(row.sourceTs).toBe(1_700_000_000);
    expect(row.detectedAtMs).toBe(1_700_000_099_000);
    expect(row.detectedAtMs).not.toBe(row.sourceTs * 1000);
    await processPendingSameVenueEvents({ repo, fetchBook, workerId: "w1" });
    expect(repo.fills[0]!.sourceTs).toBe(1_700_000_000);
    expect(repo.fills[0]!.detectedAtMs).toBe(1_700_000_099_000);
  });

  it("12. no configured external source adapter means nothing is fabricated", async () => {
    const repo = new MemoryRepo();
    const result = await runKalshiSourceIngestCycle({ source: null, repo, now: () => 1, traders: [{ traderId: TRADER, sinceTsSeconds: 0 }] });
    expect(result).toEqual({ configured: false, fetched: 0, admitted: 0, duplicates: 0, rejected: 0 });
    expect(repo.events).toHaveLength(0);
    const { getConfiguredKalshiTraderActivitySource } = await import("./kalshi-same-venue.server");
    expect(getConfiguredKalshiTraderActivitySource()).toBeNull();
  });

  it("13. no live-order path exists in the same-venue modules", () => {
    const files = [
      "src/lib/sports-shadow/kalshi-same-venue.ts",
      "src/lib/sports-shadow/kalshi-same-venue.server.ts",
      "src/lib/sports-shadow/kalshi-source.ts",
    ];
    for (const file of files) {
      const src = readFileSync(file, "utf8");
      for (const forbidden of ["/portfolio/orders", "createOrder", "placeOrder", "LIVE_EXECUTION_IMPLEMENTED = true"]) {
        expect(src.includes(forbidden)).toBe(false);
      }
    }
    const safety = readFileSync("src/lib/live-safety/core.ts", "utf8");
    expect(safety.includes("LIVE_EXECUTION_IMPLEMENTED = false")).toBe(true);
  });

  it("14. a stale book records the attempt without fabricating a fill", async () => {
    const repo = new MemoryRepo();
    await setupWithBuy(repo);
    const outcome = await processPendingSameVenueEvents({
      repo,
      fetchBook: async () => ({ ...BOOK, staleReason: "rate limited", askLevels: [], bidLevels: [] }),
      workerId: "w1",
    });
    expect(outcome.executed).toBe(1);
    expect(repo.fills.every((f) => f.contracts === 0 && f.fillStatus === "NONE" && f.bookStaleReason === "rate limited")).toBe(true);
    expect(repo.positions.size).toBe(0);
  });
});
