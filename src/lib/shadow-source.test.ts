import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";

const src = readFileSync(new URL("./shadow.server.ts", import.meta.url), "utf8");

vi.mock("@/integrations/supabase/client.server", () => ({ supabaseAdmin: {} }));

const { fetchUntilCheckpointCovered, resolveCatchupBoundary, PAGE_SIZE } = await import("./shadow.server");

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
    const releases = src.match(/await releaseLease\(lease, \{[^}]*\}\);/gs) ?? [];
    expect(releases.length).toBeGreaterThanOrEqual(2);
    for (const release of releases) {
      expect(release).toContain("last_poll_events_inserted: cycleEventsInserted");
    }
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
