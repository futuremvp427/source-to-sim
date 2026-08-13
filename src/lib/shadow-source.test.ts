import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";

const src = readFileSync(new URL("./shadow.server.ts", import.meta.url), "utf8");

vi.mock("@/integrations/supabase/client.server", () => ({ supabaseAdmin: {} }));

const { fetchUntilCheckpointCovered, PAGE_SIZE } = await import("./shadow.server");

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
});
