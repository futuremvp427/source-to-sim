import { afterEach, describe, expect, it, vi } from "vitest";

/**
 * Phase 0A remediation, item 1: MERGE/SPLIT/REDEEM evidence capture
 * (ingestGeneralActivity) is extended from General Shadow only to also cover
 * the 10 SHADOW V2 / SHADOW V3 CAPACITY cohort experiments.
 *
 * These tests prove, independent of the real database:
 *   1. isNonTradeActivityCohort now recognizes General Shadow, V2, and V3
 *      CAPACITY experiment names (and rejects everything else).
 *   2. ingestGeneralActivity never touches any paper accounting table
 *      (paper_trades / paper_positions / paper_experiments / paper_settlements)
 *      -- it can only ever write to general_activity. This is true regardless
 *      of which cohort's cycle calls it, so extending the caller set cannot,
 *      by construction, change paper cash/position/P&L accounting.
 *   3. Re-ingesting the exact same upstream /activity page twice (e.g. two
 *      cycles observing overlapping history) inserts each distinct event
 *      exactly once -- no duplicate general_activity rows.
 *   4. Every captured row keeps economics_status = UNKNOWN_UNRESOLVED and is
 *      never a BUY/SELL action, regardless of activity type.
 */

type ActivityRow = {
  wallet: string;
  event_key: string;
  activity_type: string;
  economics_status: string;
  post_go_live: boolean;
  [key: string]: unknown;
};

function makeFakeSupabase() {
  // Simulates the real `general_activity` table's UNIQUE(wallet, event_key)
  // constraint + `ignoreDuplicates: true` upsert semantics: only genuinely
  // new (wallet, event_key) pairs are inserted and returned; already-known
  // pairs are silently skipped (as Postgres `ON CONFLICT DO NOTHING
  // RETURNING` would), not overwritten.
  const stored = new Map<string, ActivityRow>();
  const fromCalls: string[] = [];
  let nextId = 1;

  const supabaseAdmin = {
    // getActivityPage reserves a pacing slot via this RPC before every fetch
    // (see http-rate-limit.server.ts's reserveRequestSlot). It must resolve
    // to a fresh timestamp string (zero wait) for the page fetch to proceed.
    rpc: (_name: string, _args: unknown) => {
      const builder = {
        abortSignal: () => builder,
        then: (resolve: (v: { data: unknown; error: null }) => void) =>
          resolve({ data: new Date().toISOString(), error: null }),
      };
      return builder;
    },
    from: (table: string) => {
      fromCalls.push(table);
      if (table !== "general_activity") {
        throw new Error(
          `FakeSupabase: ingestGeneralActivity must never touch table "${table}" -- ` +
            "evidence capture is observation-only and must not reach paper accounting tables.",
        );
      }
      return {
        upsert: (rows: ActivityRow[]) => {
          const inserted: { id: number }[] = [];
          for (const row of rows) {
            const key = `${row.wallet}:${row.event_key}`;
            if (stored.has(key)) continue; // ON CONFLICT DO NOTHING
            stored.set(key, row);
            inserted.push({ id: nextId++ });
          }
          return {
            select: async () => ({ data: inserted, error: null }),
          };
        },
      };
    },
  };
  return { supabaseAdmin, stored, fromCalls };
}

let currentFake: ReturnType<typeof makeFakeSupabase>["supabaseAdmin"];

vi.mock("@/integrations/supabase/client.server", () => ({
  get supabaseAdmin() {
    return currentFake;
  },
}));

const { isNonTradeActivityCohort } = await import("./shadow.server");
const { ingestGeneralActivity } = await import("./general-shadow.server");
const { GS_GO_LIVE_TS } = await import("./general-shadow");

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), { status: 200 });
}

/** One MERGE and one REDEEM row for a followed wallet, plus a TRADE row that
 * must be dropped (trades are covered by the separate /trades ingestion, not
 * this evidence-only path). */
const SAMPLE_ACTIVITY_PAGE = [
  {
    type: "MERGE",
    asset: "tokenA",
    transactionHash: "0xmerge1",
    timestamp: GS_GO_LIVE_TS + 100,
    size: 12.5,
  },
  {
    type: "REDEEM",
    asset: "tokenB",
    transactionHash: "0xredeem1",
    timestamp: GS_GO_LIVE_TS + 200,
    usdcSize: 8,
  },
  {
    type: "TRADE",
    asset: "tokenA",
    side: "BUY",
    transactionHash: "0xtrade1",
    timestamp: GS_GO_LIVE_TS + 50,
    size: 3,
  },
];

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("isNonTradeActivityCohort", () => {
  it("recognizes General Shadow, V2, and V3 CAPACITY experiment names", () => {
    expect(isNonTradeActivityCohort("GENERAL SHADOW: RN1")).toBe(true);
    expect(isNonTradeActivityCohort("GENERAL SHADOW: swisstony")).toBe(true);
    expect(isNonTradeActivityCohort("SHADOW V2: Poligarch")).toBe(true);
    expect(isNonTradeActivityCohort("SHADOW V2: badatmath.")).toBe(true);
    expect(isNonTradeActivityCohort("SHADOW V3 CAPACITY: Poligarch")).toBe(true);
    expect(isNonTradeActivityCohort("SHADOW V3 CAPACITY: HighTempTation")).toBe(true);
  });

  it("still rejects unrelated experiment names (frozen V1, or anything else)", () => {
    expect(isNonTradeActivityCohort("SHADOW")).toBe(false);
    expect(isNonTradeActivityCohort("SHADOW:Poligarch")).toBe(false);
    expect(isNonTradeActivityCohort("CANDIDATE: some-wallet")).toBe(false);
    expect(isNonTradeActivityCohort("")).toBe(false);
  });

  it("requires the exact prefix at the start of the name, not merely present somewhere in it", () => {
    // Does NOT start with any of the three prefixes -> false, even though
    // "SHADOW V2: " appears later in the string.
    expect(isNonTradeActivityCohort("not SHADOW V2: Poligarch")).toBe(false);
    // Genuinely starts with "SHADOW V2: ", so it IS a V2-cohort name by the
    // same startsWith rule isV2Name itself uses -- consistent, not fuzzy.
    expect(isNonTradeActivityCohort("SHADOW V2: GENERAL SHADOW: RN1")).toBe(true);
  });
});

describe("ingestGeneralActivity is observation-only, regardless of caller cohort", () => {
  it("never touches any table other than general_activity", async () => {
    const { supabaseAdmin, fromCalls } = makeFakeSupabase();
    currentFake = supabaseAdmin;
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => jsonResponse(SAMPLE_ACTIVITY_PAGE)),
    );

    // Called exactly as the V2/V3 cycle now calls it: wallet + the
    // experiment's own follow_from_ts.
    await ingestGeneralActivity("0xV2WALLET", 1_700_000_000);

    expect(fromCalls.every((t) => t === "general_activity")).toBe(true);
    expect(fromCalls.length).toBeGreaterThan(0);
  });

  it("drops the TRADE row and never produces a BUY/SELL action for MERGE/REDEEM", async () => {
    const { supabaseAdmin, stored } = makeFakeSupabase();
    currentFake = supabaseAdmin;
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => jsonResponse(SAMPLE_ACTIVITY_PAGE)),
    );

    const outcome = await ingestGeneralActivity("0xV2WALLET", GS_GO_LIVE_TS);

    expect(outcome.nonTrade).toBe(2); // MERGE + REDEEM only, TRADE dropped
    expect(outcome.inserted).toBe(2);
    const rows = [...stored.values()];
    expect(rows.map((r) => r.activity_type).sort()).toEqual(["MERGE", "REDEEM"]);
    expect(rows.every((r) => r.economics_status === "UNKNOWN_UNRESOLVED")).toBe(true);
    // No row's action/type is ever BUY or SELL -- there is no such field to
    // set, by construction of normalizeActivity/ingestGeneralActivity, which
    // only ever writes activity_type (MERGE/REDEEM/SPLIT/...), never a
    // paper-trade action.
    expect(rows.every((r) => r.activity_type !== "BUY" && r.activity_type !== "SELL")).toBe(true);
  });

  it("stamps post_go_live from the caller-supplied goLiveTs, not a hardcoded General Shadow boundary", async () => {
    const { supabaseAdmin, stored } = makeFakeSupabase();
    currentFake = supabaseAdmin;
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => jsonResponse(SAMPLE_ACTIVITY_PAGE)),
    );

    // A V2 experiment's own follow_from_ts, deliberately far from
    // GS_GO_LIVE_TS, to prove the General Shadow constant is not silently
    // reused for a V2/V3 caller.
    const v2FollowFromTs = GS_GO_LIVE_TS + 1_000_000;
    await ingestGeneralActivity("0xV2WALLET", v2FollowFromTs);

    const rows = [...stored.values()];
    // Both sample rows (GS_GO_LIVE_TS+100, GS_GO_LIVE_TS+200) are before
    // v2FollowFromTs, so both must be marked pre-go-live for this caller.
    expect(rows.every((r) => r.post_go_live === false)).toBe(true);
  });

  it("defaults goLiveTs to the General Shadow boundary when a caller omits it (unchanged existing behavior)", async () => {
    const { supabaseAdmin, stored } = makeFakeSupabase();
    currentFake = supabaseAdmin;
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => jsonResponse(SAMPLE_ACTIVITY_PAGE)),
    );

    await ingestGeneralActivity("0xGSWALLET");

    const rows = [...stored.values()];
    expect(rows.find((r) => r.activity_type === "MERGE")?.post_go_live).toBe(true);
    expect(rows.find((r) => r.activity_type === "REDEEM")?.post_go_live).toBe(true);
  });
});

describe("duplicate activity cannot create duplicate records", () => {
  it("re-ingesting the identical upstream page twice inserts each event exactly once", async () => {
    const { supabaseAdmin, stored } = makeFakeSupabase();
    currentFake = supabaseAdmin;
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => jsonResponse(SAMPLE_ACTIVITY_PAGE)),
    );

    const first = await ingestGeneralActivity("0xDUPWALLET", GS_GO_LIVE_TS);
    const second = await ingestGeneralActivity("0xDUPWALLET", GS_GO_LIVE_TS);

    expect(first.inserted).toBe(2);
    // Second call sees the same two non-trade rows upstream again, but
    // neither is newly inserted -- the wallet+event_key pair already exists.
    expect(second.nonTrade).toBe(2);
    expect(second.inserted).toBe(0);
    expect(stored.size).toBe(2); // still exactly two rows total, not four.
  });

  it("overlapping pages across two different cohort callers for the same wallet still dedupe (V2 and V3 CAPACITY share a wallet)", async () => {
    const { supabaseAdmin, stored } = makeFakeSupabase();
    currentFake = supabaseAdmin;
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => jsonResponse(SAMPLE_ACTIVITY_PAGE)),
    );

    // V3 CAPACITY: Poligarch and SHADOW V2: Poligarch follow the identical
    // wallet address (see v3-cohort.ts: V3_COHORT = V2_COHORT), so both
    // cycles independently call ingestGeneralActivity for the same address.
    const wallet = "0xb40e89677d59665d5188541ad860450a6e2a7cc9";
    const fromV2Cycle = await ingestGeneralActivity(wallet, 1_700_000_000);
    const fromV3Cycle = await ingestGeneralActivity(wallet, 1_650_000_000);

    expect(fromV2Cycle.inserted).toBe(2);
    expect(fromV3Cycle.inserted).toBe(0);
    expect(stored.size).toBe(2);
  });

  it("a genuinely new event alongside already-known ones only inserts the new one", async () => {
    const { supabaseAdmin, stored } = makeFakeSupabase();
    currentFake = supabaseAdmin;

    let call = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        call += 1;
        if (call === 1) return jsonResponse(SAMPLE_ACTIVITY_PAGE);
        return jsonResponse([
          ...SAMPLE_ACTIVITY_PAGE,
          {
            type: "SPLIT",
            asset: "tokenC",
            transactionHash: "0xsplit1",
            timestamp: GS_GO_LIVE_TS + 300,
            size: 4,
          },
        ]);
      }),
    );

    const first = await ingestGeneralActivity("0xGROWINGWALLET", GS_GO_LIVE_TS);
    const second = await ingestGeneralActivity("0xGROWINGWALLET", GS_GO_LIVE_TS);

    expect(first.inserted).toBe(2);
    expect(second.inserted).toBe(1);
    expect(stored.size).toBe(3);
  });
});
