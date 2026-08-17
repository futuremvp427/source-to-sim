import { afterEach, describe, expect, it, vi } from "vitest";

// A working reserve_http_request_slot that always grants an immediate slot:
// these tests are about the request-storm-prevention CACHE, not pacing, so
// this exists purely to keep getJson's now-fail-CLOSED reservation gate
// (see http-rate-limit.server.ts) from blocking every fetch in this file.
// Reservation-specific behavior (fail-closed, spacing, capacity) is covered
// in reserve-http-request-slot.test.ts instead.
vi.mock("@/integrations/supabase/client.server", () => ({
  supabaseAdmin: {
    rpc: (name: string) => ({
      abortSignal: () => ({
        then: (resolve: (v: { data: unknown; error: unknown }) => void) => {
          if (name === "reserve_http_request_slot") {
            resolve({ data: new Date().toISOString(), error: null });
            return;
          }
          resolve({ data: null, error: null });
        },
      }),
    }),
  },
}));

const {
  getArrayForTest,
  fetchSourceWindowForTest,
  backoffDelayMsForTest,
  getJsonForTest,
  sleepForTest,
  parseRetryAfterMs,
  RateLimitedError,
  buildTradesUrl,
  SHARED_TRADES_FETCH_DEADLINE_MS_FOR_TEST,
} = await import("./shadow.server");

function jsonResponse(body: unknown, status = 200, headers: Record<string, string> = {}) {
  return new Response(JSON.stringify(body), { status, headers });
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  vi.useRealTimers();
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
});

describe("sibling isolation: a caller's own AbortSignal must never cancel a shared request another sibling still needs", () => {
  it("aborting one sibling's signal has zero effect on the shared upstream request or the other sibling's result", async () => {
    let capturedSignal: AbortSignal | undefined;
    vi.stubGlobal(
      "fetch",
      vi.fn((_url: string, init?: RequestInit) => {
        capturedSignal = init?.signal as AbortSignal | undefined;
        return new Promise<Response>((resolve) => {
          setTimeout(() => resolve(jsonResponse([{ timestamp: 1 }])), 5);
        });
      }),
    );

    const url = buildTradesUrl(250, 0, "0xsiblings");
    const cache = new Map();
    const siblingAAbort = new AbortController();

    // V2's own cycle-abort signal; V3 uses no signal of its own.
    const a = getArrayForTest(url, siblingAAbort.signal, cache);
    const b = getArrayForTest(url, undefined, cache);

    // Simulate V2's own EXPERIMENT_DEADLINE_MS firing early.
    siblingAAbort.abort();

    const [resultA, resultB] = await Promise.all([a, b]);
    expect(resultA).toEqual(resultB);
    expect(resultA).toEqual([{ timestamp: 1 }]);
    // The request actually sent upstream must never have been tied to
    // sibling A's own signal, so it must still be un-aborted here.
    expect(capturedSignal?.aborted).toBe(false);
  });
});

describe("the shared fetch has its own independent hard deadline", () => {
  it("does not settle merely because every experiment's own 40s deadline has passed", async () => {
    vi.useFakeTimers();
    vi.stubGlobal(
      "fetch",
      vi.fn((_url: string, init?: RequestInit) => {
        return new Promise<Response>((_resolve, reject) => {
          const signal = init?.signal as AbortSignal | undefined;
          signal?.addEventListener(
            "abort",
            () => reject(new DOMException("Aborted", "AbortError")),
            {
              once: true,
            },
          );
        });
      }),
    );

    const url = buildTradesUrl(250, 0, "0xstalled");
    const cache = new Map();
    let settled = false;
    getArrayForTest(url, undefined, cache).then(
      () => {
        settled = true;
      },
      () => {
        settled = true;
      },
    );

    // Past every experiment's own EXPERIMENT_DEADLINE_MS (40s) — the shared
    // fetch's own bound is intentionally longer, so nothing should have
    // settled yet purely from an individual experiment's perspective.
    await vi.advanceTimersByTimeAsync(40_000);
    expect(settled).toBe(false);
  });

  it("terminates (rejects) once its own hard deadline elapses, even though no individual caller ever aborted it", async () => {
    vi.useFakeTimers();
    vi.stubGlobal(
      "fetch",
      vi.fn((_url: string, init?: RequestInit) => {
        return new Promise<Response>((_resolve, reject) => {
          const signal = init?.signal as AbortSignal | undefined;
          signal?.addEventListener(
            "abort",
            () => reject(new DOMException("Aborted", "AbortError")),
            {
              once: true,
            },
          );
        });
      }),
    );

    const url = buildTradesUrl(250, 0, "0xstalled2");
    const cache = new Map();
    let settled = false;
    let rejected: unknown;
    getArrayForTest(url, undefined, cache).then(
      () => {
        settled = true;
      },
      (err) => {
        settled = true;
        rejected = err;
      },
    );

    await vi.advanceTimersByTimeAsync(SHARED_TRADES_FETCH_DEADLINE_MS_FOR_TEST + 1_000);
    expect(settled).toBe(true);
    expect(rejected).toBeDefined();
  });

  it("actually aborts the underlying fetch's signal at the hard deadline — real cancellation, not mere abandonment", async () => {
    vi.useFakeTimers();
    let capturedSignal: AbortSignal | undefined;
    vi.stubGlobal(
      "fetch",
      vi.fn((_url: string, init?: RequestInit) => {
        capturedSignal = init?.signal as AbortSignal | undefined;
        return new Promise<Response>((_resolve, reject) => {
          capturedSignal?.addEventListener(
            "abort",
            () => reject(new DOMException("Aborted", "AbortError")),
            { once: true },
          );
        });
      }),
    );

    const url = buildTradesUrl(250, 0, "0xstalled3");
    const cache = new Map();
    getArrayForTest(url, undefined, cache).catch(() => {
      /* expected */
    });

    // Flushes the (fail-open, zero-wait) reservation check's own pending
    // microtask without advancing real time, so fetch has actually been
    // invoked by the time capturedSignal is asserted below.
    await vi.advanceTimersByTimeAsync(0);
    expect(capturedSignal?.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(SHARED_TRADES_FETCH_DEADLINE_MS_FOR_TEST + 1_000);
    // Real cancellation, proven directly on the signal handed to fetch — a
    // Promise.race-only abandonment (the bug this replaces) would leave this
    // false forever, exactly like the previously-proven persistEvents issue.
    expect(capturedSignal?.aborted).toBe(true);
  });
});

describe("cache lifecycle on total failure", () => {
  it("a 429 rejects on the first attempt (no in-process retry), clears the cache entry, and a later caller performs a genuinely new fetch", async () => {
    let calls = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        calls += 1;
        return jsonResponse({}, 429, { "retry-after": "0" });
      }),
    );

    const url = buildTradesUrl(250, 0, "0xexhausted");
    const cache = new Map();

    await expect(getArrayForTest(url, undefined, cache)).rejects.toBeInstanceOf(RateLimitedError);
    // Phase 2: a 429 gets zero in-process retries -- one call, not three.
    expect(calls).toBe(1);
    expect(cache.has(url)).toBe(false); // cleared, not left as a rejected entry

    const secondCallCountBefore = calls;
    await expect(getArrayForTest(url, undefined, cache)).rejects.toBeInstanceOf(RateLimitedError);
    // A genuinely new fetch ran, not a cached rejection replayed.
    expect(calls).toBe(secondCallCountBefore + 1);
  });

  it("a non-429 failure still exhausts its bounded 3-attempt retry before the cache entry clears", async () => {
    let calls = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        calls += 1;
        return jsonResponse({}, 500);
      }),
    );

    const url = buildTradesUrl(250, 0, "0xexhausted500");
    const cache = new Map();

    await expect(getArrayForTest(url, undefined, cache)).rejects.toThrow();
    expect(calls).toBe(3);
    expect(cache.has(url)).toBe(false);
  });
});

describe("Retry-After / jittered backoff", () => {
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
    expect(new Set(samples).size).toBeGreaterThan(1);
  });

  it("backoffDelayMs ceiling never exceeds RETRY_MAX_MS even at high attempt counts", () => {
    const samples = Array.from({ length: 20 }, () => backoffDelayMsForTest(10, null));
    for (const s of samples) expect(s).toBeLessThanOrEqual(8_000);
  });

  it("a 429 without Retry-After rejects with a RateLimitedError carrying a null retryAfterMs, with zero retries", async () => {
    let calls = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        calls += 1;
        return jsonResponse({}, 429);
      }),
    );
    const url = buildTradesUrl(250, 0, "0xabc");
    await expect(getArrayForTest(url)).rejects.toBeInstanceOf(RateLimitedError);
    expect(calls).toBe(1);
  });

  it("sleepForTest resolves early when the given signal aborts before the delay elapses", async () => {
    vi.useFakeTimers();
    const controller = new AbortController();
    let resolved = false;
    sleepForTest(10_000, controller.signal).then(() => {
      resolved = true;
    });

    await vi.advanceTimersByTimeAsync(100);
    expect(resolved).toBe(false);

    controller.abort();
    await vi.advanceTimersByTimeAsync(0);
    expect(resolved).toBe(true);
  });

  it("a 429's Retry-After no longer drives any in-process wait at all (pacing moved to the shared host cooldown)", async () => {
    let calls = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        calls += 1;
        return jsonResponse({}, 429, { "retry-after": "3600" }); // 1 hour — pathological
      }),
    );

    const url = buildTradesUrl(250, 0, "0xpathological");
    // No fake timers needed at all: if Retry-After still drove an in-process
    // wait, this call would hang for (a clamped fraction of) an hour. It
    // must instead reject essentially immediately, with only the one
    // attempt that observed the 429.
    await expect(getJsonForTest(url, 3)).rejects.toBeInstanceOf(RateLimitedError);
    expect(calls).toBe(1);
  });

  it("getJson still clamps its inter-attempt backoff delay to the remaining deadline budget for non-429 failures", async () => {
    vi.useFakeTimers();
    let calls = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        calls += 1;
        return jsonResponse({}, 500);
      }),
    );

    const url = buildTradesUrl(250, 0, "0xclamped500");
    // Far tighter than backoffDelayMs's own ~8s jitter ceiling, so this only
    // passes if the deadline clamp is actually shortening the wait.
    const deadlineAt = Date.now() + 100;

    let rejected: unknown;
    const done = getJsonForTest(url, 3, undefined, deadlineAt).catch((err) => {
      rejected = err;
    });
    await vi.advanceTimersByTimeAsync(150);
    await done;

    expect(calls).toBeGreaterThanOrEqual(1);
    expect(calls).toBeLessThanOrEqual(3);
    expect(rejected).toBeDefined();
  });
});

describe("fetchSourceWindow reuses the shared cache for a bootstrap fetch", () => {
  it("two experiments bootstrapping the same wallet concurrently issue one request per page, not two", async () => {
    let calls = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        calls += 1;
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
