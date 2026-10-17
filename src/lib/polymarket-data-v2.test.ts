import { describe, expect, it } from "vitest";
import { normalizeSourceEvents } from "./shadow-core";
import { buildV2TradesUrl, createV2TradesReader, DataV2PageError, decodeV2TradePage, tradePageHasMore } from "./polymarket-data-v2";

const WALLET = "0xb40e89677d59665d5188541ad860450a6e2a7cc9";
const v2 = (data: unknown[], next: string | null = null) => ({ data, pagination: { has_more: next !== null, next_cursor: next } });
const row = { side: "BUY", size: 10, price: 0.3, timestamp: 1001, token_id: "123", condition_id: "0xcondition", transaction_hash: "0xtx", event_id: "parent-market-event", outcome: "Yes" };

describe("Data API v2 source transport", () => {
  it("always requests maker and taker fills, repeats filters, encodes opaque cursors and never sends offset", () => {
    const url = new URL(buildV2TradesUrl(WALLET, 250, "cursor+/= with space", 2000));
    expect(url.pathname).toBe("/v2/trades");
    expect(url.searchParams.get("user")).toBe(WALLET);
    expect(url.searchParams.get("taker_only")).toBe("false");
    expect(url.searchParams.get("cursor")).toBe("cursor+/= with space");
    expect(url.searchParams.get("end")).toBe("2000");
    expect(url.searchParams.has("offset")).toBe(false);
  });

  it.each([null, [], {}, { data: [] }, { data: [], pagination: {} }, { data: [null], pagination: { has_more: false } }, v2([], "more"), { data: [row], pagination: { has_more: true, next_cursor: "" } }, { data: [row], pagination: { has_more: false, next_cursor: "unexpected" } }])("rejects malformed pagination instead of counting it as empty coverage: %j", (value) => {
    expect(() => decodeV2TradePage(value)).toThrow(DataV2PageError);
  });

  it("honors has_more=true on a short page and has_more=false on a full page", () => {
    expect(tradePageHasMore(decodeV2TradePage(v2([row], "opaque")), 250)).toBe(true);
    expect(tradePageHasMore(decodeV2TradePage(v2(Array(250).fill(row))), 250)).toBe(false);
  });

  it("follows the provider cursor and preserves an inclusive time window", async () => {
    const urls: URL[] = [];
    const read = createV2TradesReader(WALLET, 250, async (url) => {
      const u = new URL(url); urls.push(u);
      return decodeV2TradePage(urls.length === 1 ? v2([row], "next+/=") : v2([{ ...row, timestamp: 999 }]));
    });
    await read(0, 2000); await read(250, 2000);
    expect(urls.map((u) => u.searchParams.get("cursor"))).toEqual([null, "next+/="]);
    expect(urls.every((u) => u.searchParams.get("end") === "2000")).toBe(true);
    expect(tradePageHasMore(await read(500, 2000), 250)).toBe(false);
    expect(urls).toHaveLength(2); // no request after an explicit terminal page
  });

  it("fails on repeated and cyclic cursors before a caller can claim complete coverage", async () => {
    for (const sequence of [["a", "a"], ["a", "b", "a"]]) {
      let i = 0;
      const read = createV2TradesReader(WALLET, 250, async () => decodeV2TradePage(v2([row], sequence[i++]!)));
      for (let p = 0; p < sequence.length - 1; p++) await read(p * 250);
      await expect(read((sequence.length - 1) * 250)).rejects.toThrow("cursor did not advance");
    }
  });

  it("does not share cursor state across wallets or a fresh bounded scan", async () => {
    const urls: URL[] = [];
    const fetchRows = async (url: string) => { urls.push(new URL(url)); return decodeV2TradePage(v2([row], "cursor-a")); };
    const a = createV2TradesReader(WALLET, 250, fetchRows);
    const b = createV2TradesReader("0xother", 250, fetchRows);
    await a(0, 2000); await b(0); await a(0, 1000);
    expect(urls.every((u) => u.searchParams.get("cursor") === null)).toBe(true);
    expect(urls.map((u) => u.searchParams.get("end"))).toEqual(["2000", null, "1000"]);
  });

  it("refuses skipped pages and a mid-chain filter change", async () => {
    const read = createV2TradesReader(WALLET, 250, async () => decodeV2TradePage(v2([row], "a")));
    await expect(read(250)).rejects.toThrow("nonsequential");
    await read(0, 2000);
    await expect(read(500, 2000)).rejects.toThrow("nonsequential");
    await expect(read(250, 1000)).rejects.toThrow("nonsequential");
  });

  it("does not reinterpret an unvalidated array as a terminal v2 page", async () => {
    const read = createV2TradesReader(WALLET, 250, async () => [row]);
    await expect(read(0)).rejects.toThrow("not validated");
  });
});

describe("v1/v2 event identity continuity", () => {
  it("keeps exactly the same identity for the same economic v1 and v2 fill", () => {
    const old = { side: "BUY", size: 10, price: 0.3, timestamp: 1001, asset: "123", conditionId: "0xcondition", transactionHash: "0xtx", outcome: "Yes" };
    const a = normalizeSourceEvents([old], WALLET)[0]!;
    const b = normalizeSourceEvents([row], WALLET)[0]!;
    expect(b.eventKey).toBe(a.eventKey);
    expect(b.asset).toBe("123"); expect(b.conditionId).toBe("0xcondition"); expect(b.txHash).toBe("0xtx");
  });

  it("never treats the parent event_id as a native fill id", () => {
    const rows = normalizeSourceEvents([row, { ...row, side: "SELL", transaction_hash: "0xtx2", size: 3 }], WALLET);
    expect(rows).toHaveLength(2);
    expect(rows.every((r) => r.sourceNativeId === null && r.identityDegraded)).toBe(true);
    expect(new Set(rows.map((r) => r.eventKey)).size).toBe(2);
  });

  it("keeps identical same-second physical fills distinct and replay-stable", () => {
    const first = normalizeSourceEvents([row, { ...row }], WALLET);
    expect(first).toHaveLength(2);
    expect(first.map((r) => r.eventKey)).toEqual(normalizeSourceEvents([row, { ...row }], WALLET).map((r) => r.eventKey));
  });

  it("continues to reject an unknown side rather than manufacturing a BUY", () => {
    expect(normalizeSourceEvents([{ ...row, side: "TRANSFER" }], WALLET)).toEqual([]);
  });
});
