import { describe, expect, it } from "vitest";
import {
  buildKalshiObservationPatch,
  buildMatchRow,
  buildObservationRows,
  buildPmusObservationPatch,
  buildTerminalFailurePatch,
  classifyKalshiFailure,
  classifyPmusFailure,
  isSchedulable,
  isValidDetectedAt,
  serializeTargetSide,
  SPORTS_SHADOW_DELAYS_MS,
  toDbSettlementCompatibility,
} from "./observation";
import type { KalshiBookSnapshot } from "./kalshi";
import type { VenueMatchResult } from "./resolver";
import type { BookSnapshot } from "./types";

function exactResult(overrides: Partial<VenueMatchResult> = {}): VenueMatchResult {
  return {
    venue: "PMUS",
    status: "EXACT",
    reasonCode: "EXACT_MATCH",
    reason: "matched",
    sourceConditionId: "0xcond",
    sourceMarketSlug: "mlb-nyy-bal-2026-08-19",
    targetEventId: "ev-1",
    targetMarketId: "444031",
    targetFetchKey: "aec-mlb-nyy-bal-2026-08-19",
    targetGameIdentifier: "game-1",
    targetAwayTeam: "NYY",
    targetHomeTeam: "BAL",
    targetBetType: "MONEYLINE",
    sourceLine: null,
    targetLine: null,
    sourceStartTime: "2026-08-19T22:35:00Z",
    targetStartTime: "2026-08-19T22:35:00Z",
    targetSide: { kind: "TEAM", team: "NYY" },
    targetPmusOrientation: "LONG",
    settlementCompatibility: "COMPATIBLE",
    settlementProfile: { extraInnings: "EXACT_COMPATIBLE", postponement: "EXACT_COMPATIBLE", pushRisk: "EXACT_COMPATIBLE" },
    candidateCounts: { exact: 1, near: 0, unverified: 0, total: 1 },
    evidence: ["game identity established via unique team-pair match"],
    ...overrides,
  };
}

describe("SPORTS_SHADOW_DELAYS_MS", () => {
  it("is exactly {0, 5000, 10000, 30000, 60000}", () => {
    expect(SPORTS_SHADOW_DELAYS_MS).toEqual([0, 5_000, 10_000, 30_000, 60_000]);
  });
});

describe("toDbSettlementCompatibility", () => {
  it("maps the resolver's UNVERIFIED to the DB's UNKNOWN", () => {
    expect(toDbSettlementCompatibility("UNVERIFIED")).toBe("UNKNOWN");
  });
  it("passes COMPATIBLE/INCOMPATIBLE through unchanged", () => {
    expect(toDbSettlementCompatibility("COMPATIBLE")).toBe("COMPATIBLE");
    expect(toDbSettlementCompatibility("INCOMPATIBLE")).toBe("INCOMPATIBLE");
  });
});

describe("serializeTargetSide", () => {
  it("serializes a team side, YES/NO/OVER/UNDER, and null (no orientation argument -- unchanged legacy shape)", () => {
    expect(serializeTargetSide({ kind: "TEAM", team: "NYY" })).toBe("TEAM:NYY");
    expect(serializeTargetSide({ kind: "YES" })).toBe("YES");
    expect(serializeTargetSide({ kind: "NO" })).toBe("NO");
    expect(serializeTargetSide({ kind: "OVER" })).toBe("OVER");
    expect(serializeTargetSide({ kind: "UNDER" })).toBe("UNDER");
    expect(serializeTargetSide(null)).toBeNull();
  });

  it("Task 12G/P1-J: appends a durable :LONG/:SHORT suffix when a pmusOrientation is given", () => {
    expect(serializeTargetSide({ kind: "TEAM", team: "NYY" }, "LONG")).toBe("TEAM:NYY:LONG");
    expect(serializeTargetSide({ kind: "TEAM", team: "BAL" }, "SHORT")).toBe("TEAM:BAL:SHORT");
    expect(serializeTargetSide({ kind: "OVER" }, "LONG")).toBe("OVER:LONG");
    expect(serializeTargetSide({ kind: "UNDER" }, "SHORT")).toBe("UNDER:SHORT");
  });

  it("Task 12G/P1-J: Kalshi YES/NO is never suffixed, even if an orientation were somehow passed (defense in depth -- resolveKalshiMatch never produces one)", () => {
    expect(serializeTargetSide({ kind: "YES" }, null)).toBe("YES");
    expect(serializeTargetSide({ kind: "NO" }, null)).toBe("NO");
  });
});

describe("buildMatchRow — match persistence for every status", () => {
  it("1. an EXACT PM-US match row is built with a usable fetch key and resolved side", () => {
    const row = buildMatchRow("sig-1", exactResult());
    expect(row.matchStatus).toBe("EXACT");
    expect(row.targetMarketId).toBe("aec-mlb-nyy-bal-2026-08-19"); // the FETCH KEY, not the raw numeric id
    expect(row.targetIdentifier).toBe("444031");
    expect(row.selectedSide).toBe("TEAM:NYY:LONG"); // Task 12G/P1-J: orientation suffix durably persisted
    expect(row.settlementCompatibility).toBe("COMPATIBLE");
  });

  it("2. an EXACT Kalshi match row is built", () => {
    const row = buildMatchRow(
      "sig-1",
      exactResult({ venue: "KALSHI", targetMarketId: "KXMLBGAME-1-NYY", targetFetchKey: "KXMLBGAME-1-NYY", targetSide: { kind: "YES" }, targetPmusOrientation: null }),
    );
    expect(row.venue).toBe("KALSHI");
    expect(row.targetMarketId).toBe("KXMLBGAME-1-NYY");
    expect(row.selectedSide).toBe("YES");
  });

  it("3/4/5. NEAR/NONE/UNVERIFIED match rows are built too, just not schedulable", () => {
    for (const status of ["NEAR", "NONE", "UNVERIFIED"] as const) {
      const result = exactResult({ status, targetFetchKey: status === "NEAR" ? "some-slug" : null, targetSide: null });
      const row = buildMatchRow("sig-1", result);
      expect(row.matchStatus).toBe(status);
      expect(isSchedulable(result)).toBe(false);
    }
  });
});

describe("isSchedulable", () => {
  it("is true only for EXACT + a fetch key + a resolved side", () => {
    expect(isSchedulable(exactResult())).toBe(true);
  });

  it("is false for EXACT missing a fetch key (defensive — should not happen for a genuine EXACT result)", () => {
    expect(isSchedulable(exactResult({ targetFetchKey: null }))).toBe(false);
  });

  it("is false for EXACT missing a resolved side (defensive)", () => {
    expect(isSchedulable(exactResult({ targetSide: null }))).toBe(false);
  });

  it("J9: is false for a PMUS EXACT result missing pmusOrientation (never schedulable without a resolved LONG/SHORT view)", () => {
    expect(isSchedulable(exactResult({ targetPmusOrientation: null }))).toBe(false);
  });

  it("a Kalshi EXACT result is unaffected by targetPmusOrientation (always null, never checked for Kalshi)", () => {
    expect(isSchedulable(exactResult({ venue: "KALSHI", targetSide: { kind: "YES" }, targetPmusOrientation: null }))).toBe(true);
  });

  it("is false for NEAR/NONE/UNVERIFIED even if a fetch key happens to be present", () => {
    expect(isSchedulable(exactResult({ status: "NEAR" }))).toBe(false);
    expect(isSchedulable(exactResult({ status: "NONE" }))).toBe(false);
    expect(isSchedulable(exactResult({ status: "UNVERIFIED" }))).toBe(false);
  });
});

describe("buildObservationRows — scheduling", () => {
  const detectedAtMs = 1_700_000_000_000; // arbitrary fixed epoch ms
  const sourceTs = "2026-08-19T22:00:00Z"; // deliberately earlier than detection

  it("9/10. creates exactly 5 rows", () => {
    const rows = buildObservationRows("sig-1", "match-1", "PMUS", detectedAtMs, sourceTs)!;
    expect(rows).toHaveLength(5);
    const rowsK = buildObservationRows("sig-1", "match-1", "KALSHI", detectedAtMs, sourceTs)!;
    expect(rowsK).toHaveLength(5);
  });

  it("11. delays are exactly {0,5000,10000,30000,60000}", () => {
    const rows = buildObservationRows("sig-1", "match-1", "PMUS", detectedAtMs, sourceTs)!;
    expect(rows.map((r) => r.requestedDelayMs)).toEqual([0, 5_000, 10_000, 30_000, 60_000]);
  });

  it("12/14. fire_at derives from detectedAt: +0 fire_at equals detectedAt exactly", () => {
    const rows = buildObservationRows("sig-1", "match-1", "PMUS", detectedAtMs, sourceTs)!;
    expect(rows[0]!.fireAt).toBe(new Date(detectedAtMs).toISOString());
  });

  it("15. +60 fire_at = detectedAt + 60000", () => {
    const rows = buildObservationRows("sig-1", "match-1", "PMUS", detectedAtMs, sourceTs)!;
    expect(rows[4]!.fireAt).toBe(new Date(detectedAtMs + 60_000).toISOString());
  });

  it("13. sourceTimestamp does NOT affect fire_at (a wildly different source timestamp yields the same fire_at values)", () => {
    const rowsA = buildObservationRows("sig-1", "match-1", "PMUS", detectedAtMs, "2020-01-01T00:00:00Z")!;
    const rowsB = buildObservationRows("sig-1", "match-1", "PMUS", detectedAtMs, "2030-01-01T00:00:00Z")!;
    expect(rowsA.map((r) => r.fireAt)).toEqual(rowsB.map((r) => r.fireAt));
    expect(rowsA.map((r) => r.sourceTimestamp)).not.toEqual(rowsB.map((r) => r.sourceTimestamp));
  });

  it("preserves sourceTimestamp verbatim as required evidence, distinct from fireAt", () => {
    const rows = buildObservationRows("sig-1", "match-1", "PMUS", detectedAtMs, sourceTs)!;
    for (const r of rows) expect(r.sourceTimestamp).toBe(sourceTs);
  });

  it("19. an invalid detectedAt fails closed (returns null, schedules nothing)", () => {
    expect(buildObservationRows("sig-1", "match-1", "PMUS", Number.NaN, sourceTs)).toBeNull();
    expect(buildObservationRows("sig-1", "match-1", "PMUS", 0, sourceTs)).toBeNull();
    expect(buildObservationRows("sig-1", "match-1", "PMUS", -1, sourceTs)).toBeNull();
    expect(buildObservationRows("sig-1", "match-1", "PMUS", Number.POSITIVE_INFINITY, sourceTs)).toBeNull();
  });
});

describe("isValidDetectedAt", () => {
  it("accepts a finite positive epoch and rejects everything else", () => {
    expect(isValidDetectedAt(1_700_000_000_000)).toBe(true);
    expect(isValidDetectedAt(0)).toBe(false);
    expect(isValidDetectedAt(-1)).toBe(false);
    expect(isValidDetectedAt(Number.NaN)).toBe(false);
    expect(isValidDetectedAt(Number.POSITIVE_INFINITY)).toBe(false);
  });
});

describe("buildPmusObservationPatch — capture patch building", () => {
  const fireAt = "2026-08-19T22:35:05.000Z"; // +5s delay window
  const requestedDelayMs = 5_000;

  function book(overrides: Partial<BookSnapshot> = {}): BookSnapshot {
    return {
      venue: "PMUS",
      marketId: "aec-mlb-nyy-bal-2026-08-19",
      bestBid: 0.58,
      bestAsk: 0.6,
      bidLevels: [{ price: 0.58, size: 100 }],
      askLevels: [{ price: 0.6, size: 50 }],
      marketStatus: "MARKET_STATE_OPEN",
      observedAt: new Date("2026-08-19T22:35:05.500Z").getTime(),
      staleReason: null,
      ...overrides,
    };
  }

  it("27/28. persists real best bid/ask and top-of-book depth", () => {
    const patch = buildPmusObservationPatch(book(), "LONG", fireAt, requestedDelayMs);
    expect(patch.bestBid).toBe(0.58);
    expect(patch.bestAsk).toBe(0.6);
    expect(patch.bidDepth).toEqual([{ price: 0.58, size: 100 }]);
    expect(patch.askDepth).toEqual([{ price: 0.6, size: 50 }]);
    expect(patch.spread).toBeCloseTo(0.02, 9);
  });

  it("29. fewer than five levels are preserved as-is, never padded", () => {
    const patch = buildPmusObservationPatch(book({ bidLevels: [{ price: 0.58, size: 100 }] }), "LONG", fireAt, requestedDelayMs);
    expect(patch.bidDepth).toHaveLength(1);
  });

  it("30. a PM-US fetch failure is persisted explicitly with a classified error code", () => {
    const patch = buildPmusObservationPatch(book({ bestBid: null, bestAsk: null, bidLevels: [], askLevels: [], staleReason: "gateway.polymarket.us request failed (HTTP 500)" }), "LONG", fireAt, requestedDelayMs);
    expect(patch.stale).toBe(true);
    expect(patch.errorCode).toBe("TRANSPORT_HTTP_ERROR");
    expect(patch.reason).toMatch(/HTTP 500/);
  });

  it("31. a genuinely valid empty book is distinguished from a transport failure", () => {
    const patch = buildPmusObservationPatch(book({ bestBid: null, bestAsk: null, bidLevels: [], askLevels: [], staleReason: null }), "LONG", fireAt, requestedDelayMs);
    expect(patch.stale).toBe(false);
    expect(patch.errorCode).toBeNull();
    expect(patch.bidDepth).toEqual([]);
    expect(patch.askDepth).toEqual([]);
  });

  it("41/42. requested_delay_ms is preserved via the caller, observed_at is the ACTUAL injected book.observedAt", () => {
    const patch = buildPmusObservationPatch(book(), "LONG", fireAt, requestedDelayMs);
    expect(patch.observedAt).toBe(new Date(book().observedAt).toISOString());
  });

  it("43/44. a late collection does not rewrite fire_at and does not pretend observed_at == fire_at", () => {
    const lateBook = book({ observedAt: new Date("2026-08-19T22:35:12.150Z").getTime() }); // fired for +5s, actually captured ~7s late
    const patch = buildPmusObservationPatch(lateBook, "LONG", fireAt, requestedDelayMs);
    expect(patch.observedAt).toBe("2026-08-19T22:35:12.150Z");
    expect(patch.observedAt).not.toBe(fireAt); // never coerced to match fire_at
  });

  it("45. actual delay is derivable: observedAt - (fireAt - requestedDelayMs) reconstructs true detection latency", () => {
    const lateBook = book({ observedAt: new Date("2026-08-19T22:35:12.150Z").getTime() });
    const patch = buildPmusObservationPatch(lateBook, "LONG", fireAt, requestedDelayMs);
    // detectedAt = fireAt(22:35:05.000) - requestedDelayMs(5000ms) = 22:35:00.000
    // detectionLatencyMs = observedAt(22:35:12.150) - detectedAt(22:35:00.000) = 12150ms
    expect(patch.detectionLatencyMs).toBe(12_150);
  });

  /**
   * Task 12G / P1-J: J6/J7/J8 -- the LONG/SHORT executable-view transform. Proven against
   * the SAME real-market shape confirmed live during this task: bestBid=0.3950,
   * bestAsk=0.4000 (an asymmetric market, deliberately NOT near 0.5, so a complement bug
   * would be immediately visible rather than hidden by near-symmetric numbers).
   */
  const asymmetricBook = book({
    bestBid: 0.395,
    bestAsk: 0.4,
    bidLevels: [
      { price: 0.395, size: 303.49 },
      { price: 0.39, size: 3 },
      { price: 0.385, size: 445.29 },
    ],
    askLevels: [
      { price: 0.4, size: 254 },
      { price: 0.405, size: 64 },
      { price: 0.41, size: 1162.95 },
    ],
  });

  it("J6: the LONG view leaves bestBid/bestAsk/bidLevels/askLevels completely unchanged from the raw fetched book", () => {
    const patch = buildPmusObservationPatch(asymmetricBook, "LONG", fireAt, requestedDelayMs);
    expect(patch.bestBid).toBe(0.395);
    expect(patch.bestAsk).toBe(0.4);
    expect(patch.bidDepth).toEqual(asymmetricBook.bidLevels);
    expect(patch.askDepth).toEqual(asymmetricBook.askLevels);
  });

  it("J7: the SHORT view complements bestBid/bestAsk (short_bid=1-long_ask, short_ask=1-long_bid) and ALL depth levels", () => {
    const patch = buildPmusObservationPatch(asymmetricBook, "SHORT", fireAt, requestedDelayMs);
    expect(patch.bestBid).toBeCloseTo(1 - 0.4, 12); // 0.6
    expect(patch.bestAsk).toBeCloseTo(1 - 0.395, 12); // 0.605
    // SHORT bids derive from LONG asks (price -> 1-price).
    expect(patch.bidDepth).toEqual([
      { price: 1 - 0.4, size: 254 },
      { price: 1 - 0.405, size: 64 },
      { price: 1 - 0.41, size: 1162.95 },
    ]);
    // SHORT asks derive from LONG bids (price -> 1-price).
    expect(patch.askDepth).toEqual([
      { price: 1 - 0.395, size: 303.49 },
      { price: 1 - 0.39, size: 3 },
      { price: 1 - 0.385, size: 445.29 },
    ]);
  });

  it("J8: SHORT transformation preserves sizes exactly and produces correctly-sorted executable depth (bids descending, asks ascending)", () => {
    const patch = buildPmusObservationPatch(asymmetricBook, "SHORT", fireAt, requestedDelayMs);
    const bidPrices = patch.bidDepth.map((l) => l.price);
    const askPrices = patch.askDepth.map((l) => l.price);
    expect(bidPrices).toEqual([...bidPrices].sort((a, b) => b - a)); // descending
    expect(askPrices).toEqual([...askPrices].sort((a, b) => a - b)); // ascending
    expect(patch.bidDepth.map((l) => l.size)).toEqual([254, 64, 1162.95]); // sizes preserved, unrounded
    expect(patch.askDepth.map((l) => l.size)).toEqual([303.49, 3, 445.29]);
  });

  it("SHORT spread is computed from the SHORT view's own bestBid/bestAsk, not the raw LONG spread", () => {
    const patch = buildPmusObservationPatch(asymmetricBook, "SHORT", fireAt, requestedDelayMs);
    expect(patch.spread).toBeCloseTo((1 - 0.395) - (1 - 0.4), 9); // 0.005, same magnitude as the LONG spread but on the complementary side
  });

  it("a stale/failed fetch (bestBid/bestAsk already null) is unaffected by orientation -- 1-null is never computed for either LONG or SHORT", () => {
    const failedBook = book({ bestBid: null, bestAsk: null, bidLevels: [], askLevels: [], staleReason: "gateway.polymarket.us request failed (HTTP 500)" });
    const longPatch = buildPmusObservationPatch(failedBook, "LONG", fireAt, requestedDelayMs);
    const shortPatch = buildPmusObservationPatch(failedBook, "SHORT", fireAt, requestedDelayMs);
    expect(longPatch.bestBid).toBeNull();
    expect(longPatch.bestAsk).toBeNull();
    expect(shortPatch.bestBid).toBeNull();
    expect(shortPatch.bestAsk).toBeNull();
    expect(shortPatch.stale).toBe(true);
    expect(shortPatch.errorCode).toBe("TRANSPORT_HTTP_ERROR");
  });

  it("retains the RAW fetched LONG-side book in rawMetadata when the persisted view is transformed to SHORT (auditability)", () => {
    const patch = buildPmusObservationPatch(asymmetricBook, "SHORT", fireAt, requestedDelayMs);
    expect(patch.rawMetadata).toMatchObject({
      orientation: "SHORT",
      rawLongBook: { bestBid: 0.395, bestAsk: 0.4 },
    });
  });

  it("LONG rawMetadata does not carry a redundant rawLongBook copy (the persisted view already IS the raw long book)", () => {
    const patch = buildPmusObservationPatch(asymmetricBook, "LONG", fireAt, requestedDelayMs);
    expect(patch.rawMetadata).toEqual({ venue: "PMUS", orientation: "LONG" });
  });

  /**
   * J11: Task 9's depth-walk (walkBuyDepth) is a pure consumer of whatever askLevels it's
   * given -- it never remaps venue/orientation itself (see its own doc comment). Proving
   * the SHORT-transformed ask depth this module persists is exactly what a later
   * depth-walk call would correctly consume is therefore a property of the persisted
   * data being correct, not of depth-walk.ts, which needs no changes.
   */
  it("J11: the persisted SHORT ask depth is exactly what a Task 9 depth-walk over the executable SHORT contract would need (oriented, not the raw LONG ask depth)", () => {
    const patch = buildPmusObservationPatch(asymmetricBook, "SHORT", fireAt, requestedDelayMs);
    // The SHORT ask depth must NOT equal the raw LONG ask depth -- if it did, a
    // depth-walk consumer would be executing against the wrong contract's liquidity.
    expect(patch.askDepth).not.toEqual(asymmetricBook.askLevels);
    // It must instead be the complement of the LONG bid depth (what SHORT buyers
    // actually walk through).
    expect(patch.askDepth[0]!.price).toBeCloseTo(1 - asymmetricBook.bidLevels[0]!.price, 12);
  });
});

describe("classifyPmusFailure / classifyKalshiFailure", () => {
  it("classifies known failure shapes distinctly", () => {
    expect(classifyPmusFailure("crossed book: best bid 0.6 >= best ask 0.59")).toBe("CROSSED_BOOK");
    expect(classifyPmusFailure("malformed book payload: not an object")).toBe("MALFORMED_PAYLOAD");
    expect(classifyPmusFailure("gateway.polymarket.us rate limited (429) on /x")).toBe("TRANSPORT_HTTP_429");
    expect(classifyPmusFailure("gateway.polymarket.us is in cooldown: reason")).toBe("TRANSPORT_COOLDOWN");
    expect(classifyPmusFailure("gateway.polymarket.us request failed (HTTP 503)")).toBe("TRANSPORT_HTTP_ERROR");
    expect(classifyPmusFailure("gateway.polymarket.us request failed: The operation was aborted")).toBe("TRANSPORT_TIMEOUT");
    expect(classifyPmusFailure("something entirely unrecognized")).toBe("TRANSPORT_FAILURE");
  });

  it("classifies Kalshi failures with the same vocabulary", () => {
    expect(classifyKalshiFailure("crossed YES book: bid 6000 > ask 5000 (1e-4 units)")).toBe("CROSSED_BOOK");
    expect(classifyKalshiFailure("external-api.kalshi.com rate limited (429) on /x")).toBe("TRANSPORT_HTTP_429");
  });
});

describe("buildKalshiObservationPatch — resolved-side executable view", () => {
  const fireAt = "2026-08-19T22:35:05.000Z";
  const requestedDelayMs = 5_000;

  function kalshiBook(overrides: Partial<KalshiBookSnapshot> = {}): KalshiBookSnapshot {
    return {
      venue: "KALSHI",
      marketId: "KXMLBGAME-1-NYY",
      observedAt: new Date("2026-08-19T22:35:05.400Z").getTime(),
      yes: { bestBid: 0.58, bestAsk: 0.6, bestBidUnits: 5800, bestAskUnits: 6000, bidLevels: [{ price: 0.58, size: 301.17 }], askLevels: [{ price: 0.6, size: 511.03 }] },
      no: { bestBid: 0.4, bestAsk: 0.42, bestBidUnits: 4000, bestAskUnits: 4200, bidLevels: [{ price: 0.4, size: 200 }], askLevels: [{ price: 0.42, size: 300 }] },
      rawYesBids: [{ price: 0.58, size: 301.17 }],
      rawNoBids: [{ price: 0.4, size: 200 }],
      staleReason: null,
      ...overrides,
    };
  }

  it("33. a resolved YES side persists the YES executable view", () => {
    const patch = buildKalshiObservationPatch(kalshiBook(), "YES", fireAt, requestedDelayMs);
    expect(patch.bestBid).toBe(0.58);
    expect(patch.bestAsk).toBe(0.6);
  });

  it("34. a resolved NO side persists the NO executable view, not YES", () => {
    const patch = buildKalshiObservationPatch(kalshiBook(), "NO", fireAt, requestedDelayMs);
    expect(patch.bestBid).toBe(0.4);
    expect(patch.bestAsk).toBe(0.42);
  });

  it("35. source BUY does not automatically choose YES — the caller must pass the resolved side explicitly, and NO is honored", () => {
    const patch = buildKalshiObservationPatch(kalshiBook(), "NO", fireAt, requestedDelayMs);
    expect(patch.bestBid).not.toBe(kalshiBook().yes.bestBid);
    expect(patch.rawMetadata["resolvedSide"]).toBe("NO");
  });

  it("36. sub-cent prices survive the persistence path", () => {
    const subCentBook = kalshiBook({ yes: { bestBid: 0.1234, bestAsk: 0.8766, bestBidUnits: 1234, bestAskUnits: 8766, bidLevels: [{ price: 0.1234, size: 1 }], askLevels: [{ price: 0.8766, size: 1 }] } });
    const patch = buildKalshiObservationPatch(subCentBook, "YES", fireAt, requestedDelayMs);
    expect(patch.bestBid).toBe(0.1234);
    expect(patch.bestAsk).toBe(0.8766);
  });

  it("37. fractional quantities survive the persistence path", () => {
    const patch = buildKalshiObservationPatch(kalshiBook(), "YES", fireAt, requestedDelayMs);
    expect(patch.bidDepth[0]?.size).toBe(301.17);
  });

  it("38. top-five depth is preserved without fabrication", () => {
    const fewLevels = kalshiBook({ yes: { ...kalshiBook().yes, bidLevels: [{ price: 0.58, size: 1 }] } });
    const patch = buildKalshiObservationPatch(fewLevels, "YES", fireAt, requestedDelayMs);
    expect(patch.bidDepth).toHaveLength(1);
  });

  it("39. a valid empty resolved side is handled distinctly from a transport failure", () => {
    const emptyNo = kalshiBook({ no: { bestBid: null, bestAsk: null, bestBidUnits: null, bestAskUnits: null, bidLevels: [], askLevels: [] } });
    const patch = buildKalshiObservationPatch(emptyNo, "NO", fireAt, requestedDelayMs);
    expect(patch.stale).toBe(false);
    expect(patch.errorCode).toBeNull();
    expect(patch.bestBid).toBeNull();
  });

  it("40. a crossed/invalid snapshot never becomes a fake executable quote", () => {
    const crossed = kalshiBook({ yes: { ...kalshiBook().yes, bestBid: null, bestAsk: null }, staleReason: "crossed YES book: bid 6000 > ask 5000 (1e-4 units)" });
    const patch = buildKalshiObservationPatch(crossed, "YES", fireAt, requestedDelayMs);
    expect(patch.bestBid).toBeNull();
    expect(patch.bestAsk).toBeNull();
    expect(patch.stale).toBe(true);
    expect(patch.errorCode).toBe("CROSSED_BOOK");
  });

  it("retains the full raw book (both sides) in rawMetadata for later verification", () => {
    const patch = buildKalshiObservationPatch(kalshiBook(), "YES", fireAt, requestedDelayMs);
    expect(patch.rawMetadata["rawYesBids"]).toEqual([{ price: 0.58, size: 301.17 }]);
    expect(patch.rawMetadata["rawNoBids"]).toEqual([{ price: 0.4, size: 200 }]);
  });
});

describe("buildTerminalFailurePatch", () => {
  it("produces a terminal, explicit failure patch with empty (not fabricated) depth", () => {
    const patch = buildTerminalFailurePatch(1_700_000_010_000, "MISSING_TARGET_IDENTIFIER", "no fetch key on the linked match", "2026-08-19T22:35:05.000Z", 5_000);
    expect(patch.errorCode).toBe("MISSING_TARGET_IDENTIFIER");
    expect(patch.stale).toBe(true);
    expect(patch.bidDepth).toEqual([]);
    expect(patch.askDepth).toEqual([]);
    expect(patch.bestBid).toBeNull();
  });
});
