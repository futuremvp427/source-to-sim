import { describe, expect, it, vi } from "vitest";
import { fetchSourceMarketMetadata } from "./source-metadata.server";

const GAMMA_TOTAL_FIXTURE = [
  {
    conditionId: "0x98d25978a8e8afa9e318bb75ce261f161150f42f79bec8183f0800594ed58434",
    slug: "mlb-wsh-tex-2026-08-19-total-7pt5",
    question: "Washington Nationals vs. Texas Rangers: O/U 7.5",
    groupItemTitle: "O/U 7.5",
    sportsMarketType: "totals",
    line: 7.5,
    gameStartTime: "2026-08-20 00:05:00+00",
    events: [
      {
        gameId: 10079198,
        slug: "mlb-wsh-tex-2026-08-19",
        sport: { sport: "mlb" },
        teams: [
          { name: "Washington Nationals", abbreviation: "wsh", ordering: "away" },
          { name: "Texas Rangers", abbreviation: "tex", ordering: "home" },
        ],
      },
    ],
  },
];

function fakeFetch(body: unknown, ok = true, status = 200): typeof fetch {
  return vi.fn(async () => new Response(JSON.stringify(body), { status: ok ? status : 500 })) as unknown as typeof fetch;
}

function fakeMalformedFetch(): typeof fetch {
  return vi.fn(async () => new Response("not json {{{", { status: 200 })) as unknown as typeof fetch;
}

function fakeThrowingFetch(err: unknown): typeof fetch {
  return vi.fn(async () => {
    throw err;
  }) as unknown as typeof fetch;
}

describe("fetchSourceMarketMetadata", () => {
  it("maps a real gamma-api totals market into structured, ELIGIBLE SourceMarketMetadata", async () => {
    const result = await fetchSourceMarketMetadata(
      "0x98d25978a8e8afa9e318bb75ce261f161150f42f79bec8183f0800594ed58434",
      fakeFetch(GAMMA_TOTAL_FIXTURE),
    );
    expect(result).toEqual({
      conditionId: "0x98d25978a8e8afa9e318bb75ce261f161150f42f79bec8183f0800594ed58434",
      league: "mlb",
      sportsMarketType: "totals",
      betType: "TOTAL",
      status: "ELIGIBLE",
      reasonCode: "ELIGIBLE_FULL_GAME_TOTAL",
      ineligibleReason: null,
      line: 7.5,
      awayTeam: "Washington Nationals",
      homeTeam: "Texas Rangers",
      gameStartTime: "2026-08-20 00:05:00+00",
      sourceGameId: "10079198",
      eventSlug: "mlb-wsh-tex-2026-08-19",
      marketSlug: "mlb-wsh-tex-2026-08-19-total-7pt5",
    });
  });

  it("returns an INELIGIBLE result rather than throwing for a prop market", async () => {
    const propFixture = [
      {
        ...GAMMA_TOTAL_FIXTURE[0],
        conditionId: "0xprop",
        sportsMarketType: "player_prop",
        question: "Mike Trout: Home Runs O/U 0.5",
      },
    ];
    const result = await fetchSourceMarketMetadata("0xprop", fakeFetch(propFixture));
    expect(result.status).toBe("INELIGIBLE");
    expect(result.betType).toBeNull();
    expect(result.reasonCode).toBe("REJECT_PROP");
  });

  it("26. fails closed with UNVERIFIED_FETCH_FAILED on a request that throws (e.g. timeout/abort)", async () => {
    const result = await fetchSourceMarketMetadata("0xtimeout", fakeThrowingFetch(new DOMException("The operation was aborted", "AbortError")));
    expect(result.status).toBe("UNVERIFIED");
    expect(result.betType).toBeNull();
    expect(result.reasonCode).toBe("UNVERIFIED_FETCH_FAILED");
  });

  it("26b. fails closed with UNVERIFIED_FETCH_FAILED on an HTTP error status", async () => {
    const result = await fetchSourceMarketMetadata("0xerr", fakeFetch({}, false));
    expect(result.status).toBe("UNVERIFIED");
    expect(result.betType).toBeNull();
    expect(result.reasonCode).toBe("UNVERIFIED_FETCH_FAILED");
  });

  it("27. fails closed with UNVERIFIED_EMPTY_RESPONSE when gamma-api returns no market for the conditionId", async () => {
    const result = await fetchSourceMarketMetadata("0xmissing", fakeFetch([]));
    expect(result.status).toBe("UNVERIFIED");
    expect(result.betType).toBeNull();
    expect(result.reasonCode).toBe("UNVERIFIED_EMPTY_RESPONSE");
  });

  it("28. fails closed with UNVERIFIED_MALFORMED_RESPONSE on non-JSON response bodies", async () => {
    const result = await fetchSourceMarketMetadata("0xmalformed", fakeMalformedFetch());
    expect(result.status).toBe("UNVERIFIED");
    expect(result.betType).toBeNull();
    expect(result.reasonCode).toBe("UNVERIFIED_MALFORMED_RESPONSE");
  });

  it("28b. fails closed with UNVERIFIED_MALFORMED_RESPONSE when the response shape is not an array", async () => {
    const result = await fetchSourceMarketMetadata("0xshape", fakeFetch({ not: "an array" }));
    expect(result.status).toBe("UNVERIFIED");
    expect(result.betType).toBeNull();
    expect(result.reasonCode).toBe("UNVERIFIED_MALFORMED_RESPONSE");
  });
});
