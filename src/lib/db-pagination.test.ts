import { describe, expect, it } from "vitest";

import { PAGE_ROWS, fetchAllRows } from "./db-pagination";
import { reconcileSourceState, replaySourcePositions } from "./shadow-core";

/** PostgREST behaviour: never more than PAGE_ROWS rows, whatever limit is asked for. */
function postgrestTable<T>(rows: T[]) {
  return {
    /** The old, buggy read: one request with a large `.limit()`. */
    limit(n: number): T[] {
      return rows.slice(0, Math.min(n, PAGE_ROWS));
    },
    range(from: number, to: number): T[] {
      return rows.slice(from, Math.min(to + 1, from + PAGE_ROWS));
    },
  };
}

type Fill = { asset: string; side: "BUY" | "SELL"; shares: number };

/** 2861 persisted fills: the first 1000 on old assets, the rest on newer ones. */
function persistedFills(): Fill[] {
  const fills: Fill[] = [];
  for (let i = 0; i < 1000; i += 1) fills.push({ asset: `old-${i % 50}`, side: "BUY", shares: 1 });
  for (let i = 0; i < 1861; i += 1) fills.push({ asset: `new-${i % 40}`, side: "BUY", shares: 2 });
  return fills;
}

describe("fetchAllRows", () => {
  it("reads every row across pages despite the 1000-row cap", async () => {
    const table = postgrestTable(persistedFills());
    const paged = await fetchAllRows<Fill>(async (from, to) => table.range(from, to));
    expect(paged.complete).toBe(true);
    expect(paged.rows).toHaveLength(2861);
    expect(paged.pages).toBe(3);
  });

  it("reports incomplete instead of silently truncating when the page cap is hit", async () => {
    const table = postgrestTable(persistedFills());
    const paged = await fetchAllRows<Fill>(async (from, to) => table.range(from, to), {
      maxPages: 1,
    });
    expect(paged.complete).toBe(false);
    expect(paged.rows).toHaveLength(1000);
  });

  it("terminates on an exact page-size boundary", async () => {
    const rows = Array.from({ length: PAGE_ROWS * 2 }, (_, i) => ({ i }));
    const table = postgrestTable(rows);
    const paged = await fetchAllRows(async (from, to) => table.range(from, to));
    expect(paged.rows).toHaveLength(PAGE_ROWS * 2);
    expect(paged.complete).toBe(true);
  });
});

describe("reconciliation replay completeness (regression)", () => {
  const fills = persistedFills();
  /** Correct incremental state: every fill applied exactly once. */
  const incremental = replaySourcePositions(fills);

  it("reproduces the phantom mismatches caused by a single capped request", async () => {
    const table = postgrestTable(fills);
    const truncated = replaySourcePositions(table.limit(5000));
    const result = reconcileSourceState(incremental, truncated);
    expect(result.ok).toBe(false);
    // Every "new-*" asset is reported as compact > 0, replayed = 0 — the exact
    // signature seen in production.
    expect(result.mismatches.length).toBe(40);
    for (const m of result.mismatches) {
      expect(m.asset.startsWith("new-")).toBe(true);
      expect(m.replayed).toBe(0);
      expect(m.compact).toBeGreaterThan(0);
    }
  });

  it("finds zero mismatches once the replay is paged", async () => {
    const table = postgrestTable(fills);
    const paged = await fetchAllRows<Fill>(async (from, to) => table.range(from, to));
    expect(paged.complete).toBe(true);
    expect(reconcileSourceState(incremental, replaySourcePositions(paged.rows)).ok).toBe(true);
  });

  it("stays clean across repeated cron cycles that append new fills", async () => {
    const live = [...fills];
    const state = new Map(incremental);
    for (let cycle = 0; cycle < 5; cycle += 1) {
      // Incremental update, exactly as the ingest path applies it.
      for (let i = 0; i < 7; i += 1) {
        const fill: Fill = { asset: `new-${i}`, side: i % 3 === 0 ? "SELL" : "BUY", shares: 1 };
        live.push(fill);
        const before = state.get(fill.asset) ?? 0;
        state.set(
          fill.asset,
          fill.side === "BUY" ? before + fill.shares : Math.max(0, before - fill.shares),
        );
      }
      const table = postgrestTable(live);
      const paged = await fetchAllRows<Fill>(async (from, to) => table.range(from, to));
      const result = reconcileSourceState(state, replaySourcePositions(paged.rows));
      expect(result.mismatches).toEqual([]);
      expect(result.ok).toBe(true);
    }
  });
});
