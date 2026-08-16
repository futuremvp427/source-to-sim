import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";

const src = readFileSync(new URL("./shadow.server.ts", import.meta.url), "utf8");

vi.mock("@/integrations/supabase/client.server", () => ({ supabaseAdmin: {} }));

const {
  fetchUntilCheckpointCovered,
  resolveCatchupBoundary,
  PAGE_SIZE,
  MAX_TRADES_OFFSET,
  CatchupProgressionError,
  buildTradesUrl,
  fetchFixedPages,
  CycleAbortedError,
} = await import("./shadow.server");

type Json = Record<string, unknown>;

describe("source completeness", () => {
  it("every public trades request explicitly sets takerOnly=false", () => {
    const urls = src.match(/\/trades\?[^`"']+/g) ?? [];
    expect(urls.length).toBeGreaterThan(0);
    expect(src).toContain('export const TAKER_ONLY_PARAM = "takerOnly=false";');
    for (const u of urls) expect(u).toMatch(/takerOnly=false|\$\{TAKER_ONLY_PARAM\}/);
  });
});

describe("event counters", () => {
  it("lifetime count comes from source_events, not the hand-maintained counter", () => {
    expect(src).toContain("const totalEventsPersisted = countsRes.count ?? 0;");
    expect(src).toContain("totalEventsPersisted,");
    expect(src).toContain("lastPollEventsInserted,");
  });

  it("does not expose worker_status.events_ingested as an authoritative dashboard value", () => {
    expect(src).not.toContain("eventsIngested:");
  });
});

describe("Finding K: latest-poll-inserted telemetry", () => {
  it("the dashboard no longer derives lastPollEventsInserted from first_seen_at >= last_poll_at", () => {
    expect(src).not.toMatch(/gte\(\s*"first_seen_at"\s*,\s*status\.last_poll_at\s*\)/);
  });

  it("the dashboard reads the persisted last_poll_events_inserted field from worker_status instead", () => {
    expect(src).toContain("last_poll_events_inserted");
    expect(src).toMatch(/lastPollEventsInserted:\s*number\s*\|\s*null\s*=\s*status/);
  });

  it("both the success and error lease releases record cycleEventsInserted", () => {
    // The error path's release is wrapped in its own bounded cleanup budget, so
    // it is no longer directly awaited; match the call itself either way.
    // Anchored on stage_ms (present only on the two real-cycle-completion
    // releases) so the unrelated host-cooldown-defer release -- which
    // deliberately records nothing about a cycle that never ran -- isn't
    // swept into this check.
    const releases = src.match(/releaseLease\(lease, \{[^}]*stage_ms[^}]*\}\)/gs) ?? [];
    expect(releases.length).toBeGreaterThanOrEqual(2);
    for (const release of releases) {
      expect(release).toContain("last_poll_events_inserted: cycleEventsInserted");
    }
  });

  it("cleanup releases the lease before status reads or alerting can block it", () => {
    expect(src).toContain("CLEANUP_RELEASE_DEADLINE_MS");
    expect(src).toContain('"cleanup_release_lease"');
    expect(src).toContain('"cleanup_alert"');
  });

  it("cycleEventsInserted is captured immediately after persistEvents resolves", () => {
    expect(src).toMatch(/const inserted = await timed\("persist_events",[\s\S]*?\);\s*cycleEventsInserted = inserted;/);
  });
});

describe("checkpoint-driven source catch-up", () => {
  it("Case A: keeps paging past the old fixed 2-page window until the checkpoint is covered", async () => {
    const checkpointTs = 1000;
    const pages: Json[][] = [
      Array.from({ length: PAGE_SIZE }, (_, i) => ({ timestamp: 5000 - i })), // page 0 (newest)
      Array.from({ length: PAGE_SIZE }, (_, i) => ({ timestamp: 3000 - i })), // page 1: still > checkpoint
      [{ timestamp: 999 }, { timestamp: 998 }], // page 2: crosses AND is short
    ];
    const calls: number[] = [];
    const fetchPage = async (offset: number) => {
      calls.push(offset);
      return pages[offset / PAGE_SIZE] ?? [];
    };
    const { pagesFetched } = await fetchUntilCheckpointCovered(fetchPage, checkpointTs);
    expect(pagesFetched).toBeGreaterThan(2);
    expect(pagesFetched).toBe(3);
    expect(calls).toEqual([0, PAGE_SIZE, PAGE_SIZE * 2]);
  });

  it("Case B: a full page containing a timestamp below the checkpoint establishes coverage", async () => {
    const checkpointTs = 1000;
    const page0: Json[] = [
      { timestamp: 1005 },
      { timestamp: 1002 },
      { timestamp: 999 },
      ...Array.from({ length: PAGE_SIZE - 3 }, () => ({ timestamp: 5000 })),
    ];
    const calls: number[] = [];
    const fetchPage = async (offset: number) => {
      calls.push(offset);
      return offset === 0 ? page0 : [];
    };
    const { pagesFetched } = await fetchUntilCheckpointCovered(fetchPage, checkpointTs);
    expect(pagesFetched).toBe(1);
    expect(calls).toEqual([0]);
  });

  it("Case C: an oldest timestamp exactly equal to the checkpoint does NOT prove coverage", async () => {
    const checkpointTs = 1000;
    // Full page whose minimum timestamp is exactly the checkpoint — no value below it.
    const page0: Json[] = Array.from({ length: PAGE_SIZE }, (_, i) => ({ timestamp: 1000 + i }));
    const page1: Json[] = [{ timestamp: 500 }];
    const calls: number[] = [];
    const fetchPage = async (offset: number) => {
      calls.push(offset);
      if (offset === 0) return page0;
      if (offset === PAGE_SIZE) return page1;
      return [];
    };
    const { pagesFetched } = await fetchUntilCheckpointCovered(fetchPage, checkpointTs);
    expect(calls).toEqual([0, PAGE_SIZE]);
    expect(pagesFetched).toBe(2);
  });

  it("Case D: a short page proves full API-history exhaustion even with no timestamp below the checkpoint", async () => {
    const checkpointTs = 1000;
    const shortPage: Json[] = Array.from({ length: 10 }, (_, i) => ({ timestamp: 5000 + i }));
    const calls: number[] = [];
    const fetchPage = async (offset: number) => {
      calls.push(offset);
      return shortPage;
    };
    const { pagesFetched } = await fetchUntilCheckpointCovered(fetchPage, checkpointTs);
    expect(calls).toEqual([0]);
    expect(pagesFetched).toBe(1);
  });

  it("a full page of malformed timestamps does not falsely establish coverage", async () => {
    const checkpointTs = 1000;
    // Number(null) === 0, Number("") === 0, Number("not-a-number") === NaN — none may
    // count as a genuine event below the checkpoint.
    const page0: Json[] = [
      { timestamp: null },
      { timestamp: "" },
      { timestamp: "not-a-number" },
      ...Array.from({ length: PAGE_SIZE - 3 }, () => ({ timestamp: 5000 })),
    ];
    const page1: Json[] = [{ timestamp: 500 }];
    const calls: number[] = [];
    const fetchPage = async (offset: number) => {
      calls.push(offset);
      if (offset === 0) return page0;
      if (offset === PAGE_SIZE) return page1;
      return [];
    };
    const { pagesFetched } = await fetchUntilCheckpointCovered(fetchPage, checkpointTs);
    expect(calls).toEqual([0, PAGE_SIZE]);
    expect(pagesFetched).toBe(2);
  });
});

describe("catch-up boundary fallback", () => {
  it("prefers a real positive checkpoint over follow_from_ts", () => {
    expect(resolveCatchupBoundary(500, 100)).toBe(500);
  });

  it("falls back to follow_from_ts when there is no positive checkpoint", () => {
    expect(resolveCatchupBoundary(0, 900)).toBe(900);
    expect(resolveCatchupBoundary(null, 900)).toBe(900);
  });

  it("fails closed (null) when neither a checkpoint nor follow_from_ts is valid", () => {
    expect(resolveCatchupBoundary(null, null)).toBeNull();
    expect(resolveCatchupBoundary(0, 0)).toBeNull();
    expect(resolveCatchupBoundary(undefined, undefined)).toBeNull();
  });

  it("a bootstrapped worker with no checkpoint pages against follow_from_ts until it is covered", async () => {
    const followFromTs = 900;
    const boundary = resolveCatchupBoundary(0, followFromTs);
    expect(boundary).toBe(followFromTs);

    const pages: Json[][] = [
      Array.from({ length: PAGE_SIZE }, (_, i) => ({ timestamp: 5000 - i })), // page 0 (newest)
      Array.from({ length: PAGE_SIZE }, (_, i) => ({ timestamp: 3000 - i })), // page 1: still > boundary
      [{ timestamp: 899 }], // page 2: crosses AND is short
    ];
    const calls: number[] = [];
    const fetchPage = async (offset: number) => {
      calls.push(offset);
      return pages[offset / PAGE_SIZE] ?? [];
    };
    const { pagesFetched } = await fetchUntilCheckpointCovered(fetchPage, boundary as number);
    expect(pagesFetched).toBeGreaterThan(2);
    expect(calls).toEqual([0, PAGE_SIZE, PAGE_SIZE * 2]);
  });
});

describe("windowed catch-up (Data API offset ceiling)", () => {
  const full = (ts: number): Json[] => Array.from({ length: PAGE_SIZE }, () => ({ timestamp: ts }));

  it("never requests an offset above the provider ceiling and rolls into an older end window", async () => {
    const checkpointTs = 1000;
    const calls: { offset: number; endTs: number | undefined }[] = [];
    const fetchPage = async (offset: number, endTs?: number) => {
      calls.push({ offset, endTs });
      // First window: always full pages well above the checkpoint.
      if (endTs === undefined) return full(5000 - offset / PAGE_SIZE);
      // Second window: crosses the checkpoint immediately.
      return [{ timestamp: 999 }];
    };
    const { raw } = await fetchUntilCheckpointCovered(fetchPage, checkpointTs);
    expect(Math.max(...calls.map((c) => c.offset))).toBeLessThanOrEqual(MAX_TRADES_OFFSET);
    expect(calls.filter((c) => c.endTs === undefined).length).toBe(MAX_TRADES_OFFSET / PAGE_SIZE + 1);
    const second = calls.filter((c) => c.endTs !== undefined);
    expect(second[0]).toEqual({ offset: 0, endTs: 5000 - MAX_TRADES_OFFSET / PAGE_SIZE });
    expect(raw.length).toBeGreaterThan(MAX_TRADES_OFFSET);
  });

  it("uses an inclusive end boundary so same-second boundary events are re-fetched, not skipped", async () => {
    const checkpointTs = 1000;
    const boundarySecond = 4242;
    const seen: (number | undefined)[] = [];
    const fetchPage = async (offset: number, endTs?: number) => {
      seen.push(endTs);
      if (endTs === undefined) return full(boundarySecond);
      // The older window re-serves the boundary second before older rows.
      return offset === 0 ? [{ timestamp: boundarySecond }, { timestamp: 999 }] : [];
    };
    const { raw } = await fetchUntilCheckpointCovered(fetchPage, checkpointTs);
    // end is the oldest observed timestamp itself (inclusive), not ts-1.
    expect(seen.filter((e) => e !== undefined)[0]).toBe(boundarySecond);
    const duplicates = raw.filter((r) => r["timestamp"] === boundarySecond).length;
    expect(duplicates).toBeGreaterThan(PAGE_SIZE); // duplicates allowed; nothing dropped
  });

  it("malformed timestamps cannot establish coverage or window progression", async () => {
    const checkpointTs = 1000;
    const fetchPage = async () =>
      Array.from({ length: PAGE_SIZE }, () => ({ timestamp: "not-a-number" })) as Json[];
    await expect(fetchUntilCheckpointCovered(fetchPage, checkpointTs)).rejects.toBeInstanceOf(
      CatchupProgressionError,
    );
  });

  it("fails closed when the window cannot move strictly backwards", async () => {
    const checkpointTs = 1000;
    const fetchPage = async () => full(4242);
    await expect(fetchUntilCheckpointCovered(fetchPage, checkpointTs)).rejects.toBeInstanceOf(
      CatchupProgressionError,
    );
  });

  it("buildTradesUrl keeps takerOnly=false explicit with and without a window end", () => {
    expect(buildTradesUrl(PAGE_SIZE, 0, "0xaaa")).toContain("takerOnly=false");
    expect(buildTradesUrl(PAGE_SIZE, 0, "0xaaa")).not.toContain("end=");
    const windowed = buildTradesUrl(PAGE_SIZE, 250, "0xaaa", 4242);
    expect(windowed).toContain("takerOnly=false");
    expect(windowed).toContain("end=4242");
  });
});

describe("mark_refresh has its own bounded budget (production incident)", () => {
  it("mark_refresh is wrapped in boundedStage with its own deadline and a neutral fallback, like every other auxiliary stage", () => {
    expect(src).toMatch(
      /boundedStage\(refreshMarks\(experiment\.id\), MARK_REFRESH_DEADLINE_MS, "mark_refresh", \{\s*updated: 0,\s*failed: 0,\s*\}\)/,
    );
  });

  it("has exactly one refreshMarks call site, and it is the bounded one", () => {
    const totalCalls = (src.match(/refreshMarks\(experiment\.id\)/g) ?? []).length;
    const boundedCalls = (src.match(/boundedStage\(refreshMarks\(experiment\.id\)/g) ?? []).length;
    expect(totalCalls).toBe(1);
    expect(boundedCalls).toBe(1);
  });
});

describe("checkpoint preamble has its own cycle budget (2026-08-14 production incident)", () => {
  it("the worker_checkpoints load happens inside the withDeadline-bounded region, not before it", () => {
    const deadlineCallIdx = src.indexOf('const stages = await withDeadline(');
    const checkpointLoadIdx = src.indexOf('.from("worker_checkpoints").select("*")');
    expect(deadlineCallIdx).toBeGreaterThan(-1);
    expect(checkpointLoadIdx).toBeGreaterThan(-1);
    // Before the fix, the checkpoint SELECT ran before `try` / withDeadline even
    // started, so a hung query there stranded the lease with no internal bound
    // and no recorded stage_ms/last_error — indistinguishable from a permanent
    // hang. It must now run after the deadline race has already started.
    expect(checkpointLoadIdx).toBeGreaterThan(deadlineCallIdx);
  });

  it("the first-run follow_from_ts bootstrap block also runs inside the bounded region", () => {
    const deadlineCallIdx = src.indexOf('const stages = await withDeadline(');
    const bootstrapIdx = src.indexOf("First ever run: shadow-copy only from go-live onwards.");
    expect(deadlineCallIdx).toBeGreaterThan(-1);
    expect(bootstrapIdx).toBeGreaterThan(-1);
    expect(bootstrapIdx).toBeGreaterThan(deadlineCallIdx);
  });
});

describe("persist_events is really cancelled on cycle timeout (2026-08-14 systemic incident)", () => {
  it("persistEvents accepts an AbortSignal and threads it into the source_events upsert", () => {
    expect(src).toMatch(/async function persistEvents\([^)]*signal\?:\s*AbortSignal[^)]*\)/);
    expect(src).toMatch(/\.abortSignal\(signal\)/);
  });

  it("the cycle creates its own AbortController tied to EXPERIMENT_DEADLINE_MS before the try block", () => {
    const tryIdx = src.indexOf("  try {\n    // Bounded so a hung upstream call");
    const controllerIdx = src.indexOf("const cycleAbort = new AbortController();");
    const timerIdx = src.indexOf("setTimeout(() => cycleAbort.abort(), EXPERIMENT_DEADLINE_MS)");
    expect(tryIdx).toBeGreaterThan(-1);
    expect(controllerIdx).toBeGreaterThan(-1);
    expect(timerIdx).toBeGreaterThan(-1);
    // Must exist before the try block starts, so it covers the whole cycle attempt.
    expect(controllerIdx).toBeLessThan(tryIdx);
    expect(timerIdx).toBeLessThan(tryIdx);
  });

  it("the cycle passes its AbortSignal into persistEvents", () => {
    expect(src).toMatch(/persistEvents\(events, !isGeneralShadowName\(experiment\.name\), cycleAbort\.signal\)/);
  });

  it("the abort timer is always cleared, on both the success and failure path", () => {
    const controllerIdx = src.indexOf("const cycleAbort = new AbortController();");
    const clearIdx = src.indexOf("clearTimeout(cycleAbortTimer)");
    expect(controllerIdx).toBeGreaterThan(-1);
    expect(clearIdx).toBeGreaterThan(-1);
    // A leaked, never-cleared timer would call .abort() on a controller from a
    // long-finished cycle, doing nothing useful but leaking a timer handle.
    expect(clearIdx).toBeGreaterThan(controllerIdx);
    // Must be in a finally so it runs on both the return and the catch path.
    const finallyIdx = src.lastIndexOf("finally {", clearIdx + 20);
    expect(finallyIdx).toBeGreaterThan(controllerIdx);
  });
});

/**
 * Real cancellation for the source-ingest HTTP chain (same pattern already
 * proven for persistEvents/processPendingEvents): the cycle's AbortSignal must
 * reject an in-flight page request and stop any further page from starting.
 */
describe("source ingest real cancellation", () => {
  it("A: aborting while a page fetch is pending rejects it and starts no further page", async () => {
    const controller = new AbortController();
    const calls: number[] = [];
    const fetchPage = (offset: number) =>
      new Promise<Json[]>((_resolve, reject) => {
        calls.push(offset);
        controller.signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
      });
    const p = fetchUntilCheckpointCovered(fetchPage, 1000, PAGE_SIZE, controller.signal);
    await Promise.resolve();
    controller.abort();
    await expect(p).rejects.toThrow(/aborted/i);
    expect(calls).toEqual([0]);
  });

  it("B: page 1 resolves, page 2 pends then aborts, page 3 is never requested", async () => {
    const controller = new AbortController();
    const calls: number[] = [];
    const fetchPage = (offset: number) => {
      calls.push(offset);
      if (offset === 0) {
        return Promise.resolve(Array.from({ length: PAGE_SIZE }, () => ({ timestamp: 5000 })) as Json[]);
      }
      return new Promise<Json[]>((_resolve, reject) => {
        controller.signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
      });
    };
    const p = fetchUntilCheckpointCovered(fetchPage, 1000, PAGE_SIZE, controller.signal);
    await new Promise((r) => setTimeout(r, 0));
    controller.abort();
    await expect(p).rejects.toThrow(/aborted/i);
    expect(calls).toEqual([0, PAGE_SIZE]);
  });

  it("C: fetchFixedPages cancels the in-flight page and blocks further pages", async () => {
    const controller = new AbortController();
    const calls: number[] = [];
    const fetchPage = (offset: number) => {
      calls.push(offset);
      if (offset === 0) {
        return Promise.resolve(Array.from({ length: PAGE_SIZE }, () => ({ timestamp: 5000 })) as Json[]);
      }
      return new Promise<Json[]>((_resolve, reject) => {
        controller.signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
      });
    };
    const p = fetchFixedPages(fetchPage, 4, PAGE_SIZE, controller.signal);
    await new Promise((r) => setTimeout(r, 0));
    controller.abort();
    await expect(p).rejects.toThrow(/aborted/i);
    expect(calls).toEqual([0, PAGE_SIZE]);
  });

  it("checks the abort flag before starting each page, like processPendingEvents", async () => {
    const controller = new AbortController();
    controller.abort();
    const calls: number[] = [];
    const fetchPage = async (offset: number) => {
      calls.push(offset);
      return [] as Json[];
    };
    await expect(
      fetchUntilCheckpointCovered(fetchPage, 1000, PAGE_SIZE, controller.signal),
    ).rejects.toBeInstanceOf(CycleAbortedError);
    await expect(fetchFixedPages(fetchPage, 2, PAGE_SIZE, controller.signal)).rejects.toBeInstanceOf(
      CycleAbortedError,
    );
    expect(calls).toEqual([]);
  });

  it("threads the cycle signal from runExperimentCycle's source_ingest into fetchSourceWindow", () => {
    expect(src).toMatch(/fetchSourceWindow\([\s\S]{0,300}?cycleAbort\.signal,[\s\S]{0,60}?\)/);
    expect(src).toContain("AbortSignal.timeout(12_000)");
  });
});
