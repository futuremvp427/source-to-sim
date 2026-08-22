import { describe, expect, it, vi } from "vitest";

import { checkKalshiSettlement, checkPmusSettlement } from "./settlement.server";

describe("FINAL BUILD Part 15: checkPmusSettlement", () => {
  it("a resolved market with our LONG side priced at 1 is SETTLED_WIN", async () => {
    const fetchImpl = vi.fn(async () =>
      new Response(
        JSON.stringify({ markets: [{ status: "MARKET_STATUS_RESOLVED", marketSides: [{ long: true, price: "1" }, { long: false, price: "0" }] }] }),
        { status: 200 },
      ),
    ) as unknown as typeof fetch;
    const result = await checkPmusSettlement("some-slug", "LONG", fetchImpl);
    expect(result.status).toBe("SETTLED_WIN");
    expect(result.settlementValue).toBe(1);
  });

  it("a resolved market with our SHORT side priced at 0 is SETTLED_LOSS", async () => {
    const fetchImpl = vi.fn(async () =>
      new Response(
        JSON.stringify({ markets: [{ status: "MARKET_STATUS_RESOLVED", marketSides: [{ long: true, price: "1" }, { long: false, price: "0" }] }] }),
        { status: 200 },
      ),
    ) as unknown as typeof fetch;
    const result = await checkPmusSettlement("some-slug", "SHORT", fetchImpl);
    expect(result.status).toBe("SETTLED_LOSS");
  });

  it("a still-active market is PENDING, never fabricated as settled", async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ markets: [{ status: "MARKET_STATUS_ACTIVE" }] }), { status: 200 })) as unknown as typeof fetch;
    const result = await checkPmusSettlement("some-slug", "LONG", fetchImpl);
    expect(result.status).toBe("PENDING");
  });

  it("a resolved market whose marketSides never matches our orientation is VOID, never guessed", async () => {
    const fetchImpl = vi.fn(async () =>
      new Response(JSON.stringify({ markets: [{ status: "MARKET_STATUS_RESOLVED", marketSides: [{ long: true, price: "1" }] }] }), { status: 200 }),
    ) as unknown as typeof fetch;
    const result = await checkPmusSettlement("some-slug", "SHORT", fetchImpl);
    expect(result.status).toBe("VOID");
  });

  it("a network failure propagates as a genuine error (never silently PENDING or fabricated settled)", async () => {
    const fetchImpl = vi.fn(async () => new Response("error", { status: 500 })) as unknown as typeof fetch;
    await expect(checkPmusSettlement("some-slug", "LONG", fetchImpl)).rejects.toThrow();
  });
});

describe("FINAL BUILD Part 15: checkKalshiSettlement", () => {
  it("a finalized market with result=yes and our side YES is SETTLED_WIN", async () => {
    const fetchImpl = vi.fn(async () =>
      new Response(JSON.stringify({ market: { status: "finalized", result: "yes", settlement_value_dollars: "1.0000", settlement_ts: "2026-08-22T00:00:00Z" } }), { status: 200 }),
    ) as unknown as typeof fetch;
    const result = await checkKalshiSettlement("TICKER-1", "YES", fetchImpl);
    expect(result.status).toBe("SETTLED_WIN");
    expect(result.settlementValue).toBe(1);
  });

  it("a finalized market with result=no and our side YES is SETTLED_LOSS", async () => {
    const fetchImpl = vi.fn(async () =>
      new Response(JSON.stringify({ market: { status: "finalized", result: "no", settlement_value_dollars: "0.0000" } }), { status: 200 }),
    ) as unknown as typeof fetch;
    const result = await checkKalshiSettlement("TICKER-1", "YES", fetchImpl);
    expect(result.status).toBe("SETTLED_LOSS");
  });

  it("a market still open is PENDING", async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ market: { status: "active" } }), { status: 200 })) as unknown as typeof fetch;
    const result = await checkKalshiSettlement("TICKER-1", "YES", fetchImpl);
    expect(result.status).toBe("PENDING");
  });

  it("an unrecognized result value on a finalized market is VOID, never guessed as win/loss", async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ market: { status: "finalized", result: "void" } }), { status: 200 })) as unknown as typeof fetch;
    const result = await checkKalshiSettlement("TICKER-1", "YES", fetchImpl);
    expect(result.status).toBe("VOID");
  });
});
