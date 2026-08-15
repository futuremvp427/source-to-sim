import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@/integrations/supabase/client.server", () => ({ supabaseAdmin: {} }));

const {
  getArrayForTest,
  fetchSourceWindowForTest,
  backoffDelayMsForTest,
  parseRetryAfterMs,
  RateLimitedError,
  buildTradesUrl,
} = await import("./shadow.server");

type Json = Record<string, unknown>;

function jsonResponse(body: unknown, status = 200, headers: Record<string, string> = {}) {
  return new Response(JSON.stringify(body), { status, headers });
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("shared per-cycle /trades request cache (request-storm prevention)", () => {
  it("two sibling experiments on the same wallet (V2 + V3) collapse into one upstream fetch when sharing a cache", async () => {
    let calls = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        calls += 1;
        return jsonResponse([{ timestamp: 1 }]);
      }),
    );

    const wallet = "0xabc";
    const url = buildTradesUrl(250, 0, wallet);
    const cache = new Map();

    // Simulate V2 and V3 both requesting the exact same wallet's first page
    // concurrently within the same runIngestCycle invocation.
    const [a, b] = await Promise.all([
      getArrayForTest(url, undefined, cache),
      getArrayForTest(url, undefined, cache),
    ]);

    expect(calls).toBe(1);
    expect(a).toEqual(b);
  });

  it("without a shared cache, the same two callers each fire their own request (documents the pre-fix storm)", async () => {
    let calls = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        calls += 1;
        return jsonResponse([{ timestamp: 1 }]);
      }),
    );

    const url = buildTradesUrl(250, 0, "0xabc");
    await Promise.all([getArrayForTest(url), getArrayForTest(url)]);

    expect(calls).toBe(2);
  });

  it("ten V2/V3-style workers over 5 unique wallets issue exactly 5 upstream requests when sharing one cycle cache", async () => {
    let calls = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        calls += 1;
        return jsonResponse([{ timestamp: 1 }]);
      }),
    );

    const wallets = ["0x1", "0x2", "0x3", "0x4", "0x5"];
    const cache = new Map();
    // 5 V2 workers + 5 V3 workers, each following the same 5 wallets.
    const requesters = [...wallets, ...wallets].map((wallet) =>
      getArrayForTest(buildTradesUrl(250, 0, wallet), undefined, cache),
    );
    await Promise.all(requesters);

    expect(calls).toBe(5);
  });

  it("a failed shared fetch does not poison the cache for the next batch's retry", async () => {
    let calls = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        calls += 1;
        if (calls === 1) return jsonResponse({}, 429, { "retry-after": "0" });
        return jsonResponse([{ timestamp: 1 }]);
      }),
    );

    const url = buildTradesUrl(250, 0, "0xabc");
    const cache = new Map();

    // getJson retries internally (3 attempts) before the cached promise
    // settles: the first attempt sees the 429, the second succeeds, so the
    // single cache entry resolves successfully without any caller ever
    // observing a poisoned/rejected cache entry.
    const first = await getArrayForTest(url, undefined, cache);
    expect(first).toEqual([{ timestamp: 1 }]);
    expect(calls).toBe(2); // one 429, one retry inside getJson's own attempts
  });
});

describe("Retry-After / jittered backoff (prevents retries from re-colliding on the same schedule)", () => {
  it("parseRetryAfterMs reads a delay-seconds value", () => {
    expect(parseRetryAfterMs("2")).toBe(2000);
  });

  it("parseRetryAfterMs reads an HTTP-date value", () => {
    const future = new Date(Date.now() + 5000).toUTCString();
    const ms = parseRetryAfterMs(future, Date.now());
    expect(ms).toBeGreaterThan(4000);
    expect(ms).toBeLessThanOrEqual(5000);
  });

  it("parseRetryAfterMs returns null for missing/unparseable input", () => {
    expect(parseRetryAfterMs(null)).toBeNull();
    expect(parseRetryAfterMs("not-a-date")).toBeNull();
  });

  it("backoffDelayMs uses the server-supplied Retry-After verbatim instead of the jittered schedule", () => {
    expect(backoffDelayMsForTest(0, 12_345)).toBe(12_345);
    expect(backoffDelayMsForTest(3, 0)).toBe(0);
  });

  it("backoffDelayMs falls back to bounded full-jitter exponential backoff when no Retry-After is given", () => {
    const samples = Array.from({ length: 50 }, () => backoffDelayMsForTest(0, null));
    for (const s of samples) {
      expect(s).toBeGreaterThanOrEqual(0);
      expect(s).toBeLessThanOrEqual(500);
    }
    // Jitter means retries by concurrent siblings do not all land on the
    // same instant, unlike the old fixed 400ms/800ms schedule.
    expect(new Set(samples).size).toBeGreaterThan(1);
  });

  it("backoffDelayMs ceiling never exceeds RETRY_MAX_MS even at high attempt counts", () => {
    const samples = Array.from({ length: 20 }, () => backoffDelayMsForTest(10, null));
    for (const s of samples) expect(s).toBeLessThanOrEqual(8_000);
  });

  it("a 429 without Retry-After still retries via RateLimitedError with a null retryAfterMs", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => jsonResponse({}, 429)),
    );
    const url = buildTradesUrl(250, 0, "0xabc");
    await expect(getArrayForTest(url)).rejects.toBeInstanceOf(RateLimitedError);
  });
});

describe("fetchSourceWindow reuses the shared cache for a bootstrap fetch", () => {
  it("two experiments bootstrapping the same wallet concurrently issue one request per page, not two", async () => {
    let calls = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        calls += 1;
        // Fewer than a full page ends the fixed-page walk immediately.
        return jsonResponse([{ timestamp: 1 }]);
      }),
    );

    const wallet = "0xshared";
    const cache = new Map();
    await Promise.all([
      fetchSourceWindowForTest(wallet, false, null, undefined, cache),
      fetchSourceWindowForTest(wallet, false, null, undefined, cache),
    ]);

    expect(calls).toBe(1);
  });
});
