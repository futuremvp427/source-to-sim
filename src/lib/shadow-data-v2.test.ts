import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@/integrations/supabase/client.server", () => ({ supabaseAdmin: {} }));
vi.mock("./http-rate-limit.server", async (importOriginal) => ({
  ...await importOriginal<typeof import("./http-rate-limit.server")>(),
  getHostCooldown: async () => ({ blocked: false, until: null, reason: null }),
  reserveRequestSlot: async () => 0,
  recordHostRateLimit: async () => {},
}));
const { fetchSourceWindowForTest } = await import("./shadow.server");
const WALLET = "0xb40e89677d59665d5188541ad860450a6e2a7cc9";
afterEach(() => vi.unstubAllGlobals());
const response = (ts: number, next: string | null) => new Response(JSON.stringify({ data: [{ timestamp: ts }], pagination: { has_more: next !== null, next_cursor: next } }), { status: 200 });

describe("existing shadow checkpoint engine through v2 HTTP pages", () => {
  it("walks beyond a short nonterminal page until the prior checkpoint is truly covered", async () => {
    const urls: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (url: string) => { urls.push(url); return urls.length === 1 ? response(1001, "opaque-cursor") : response(999, null); }));
    const result = await fetchSourceWindowForTest(WALLET, true, 1000);
    expect(result.pagesFetched).toBe(2);
    expect(result.raw.map((r) => r["timestamp"])).toEqual([1001, 999]);
    expect(new URL(urls[1]!).searchParams.get("cursor")).toBe("opaque-cursor");
    expect(urls.every((u) => !new URL(u).searchParams.has("offset"))).toBe(true);
  });

  it("fails closed when a cursor repeats above the checkpoint", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => response(1001, "stuck")));
    await expect(fetchSourceWindowForTest(WALLET, true, 1000)).rejects.toThrow("cursor did not advance");
  });

  it("preserves validated pagination when sibling accounts share a per-cycle request cache", async () => {
    const fetchImpl = vi.fn(async (url: string) => new URL(url).searchParams.has("cursor") ? response(999, null) : response(1001, "next"));
    vi.stubGlobal("fetch", fetchImpl);
    const cache = new Map();
    const [a, b] = await Promise.all([fetchSourceWindowForTest(WALLET, true, 1000, undefined, cache), fetchSourceWindowForTest(WALLET, true, 1000, undefined, cache)]);
    expect(a.pagesFetched).toBe(2); expect(b.raw).toEqual(a.raw); expect(fetchImpl).toHaveBeenCalledTimes(2);
  });
});
