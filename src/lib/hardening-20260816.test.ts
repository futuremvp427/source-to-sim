import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import { GENERAL_SHADOW_CATCHUP_PAGE_BUDGET, GENERAL_SHADOW_POLLING_ENABLED } from "./general-shadow";
import { normalizeSourceEvents, parseSourceSide } from "./shadow-core";
import {
  RESEARCH_BATCH_SIZE,
  RESEARCH_BUDGET_MS,
  budgetExhausted,
  selectResearchBatch,
} from "./candidates/research-batch";
import { CatchupPageBudgetExceededError, fetchUntilCheckpointCovered, PAGE_SIZE } from "./shadow.server";

const WALLET = "0x8fbd7cf5f806f563080864694415829f7229a959";

describe("fail-closed source side parsing", () => {
  it("accepts only explicit BUY/SELL, case-insensitively", () => {
    expect(parseSourceSide("BUY")).toBe("BUY");
    expect(parseSourceSide("buy")).toBe("BUY");
    expect(parseSourceSide(" Sell ")).toBe("SELL");
    expect(parseSourceSide("SELL")).toBe("SELL");
  });

  it("rejects missing, empty and unrecognized sides instead of defaulting to BUY", () => {
    expect(parseSourceSide(undefined)).toBeNull();
    expect(parseSourceSide(null)).toBeNull();
    expect(parseSourceSide("")).toBeNull();
    expect(parseSourceSide("UNKNOWN")).toBeNull();
    expect(parseSourceSide("MERGE")).toBeNull();
    expect(parseSourceSide(7)).toBeNull();
  });

  it("skips malformed-side rows in normalizeSourceEvents but keeps valid mixed-case trades", () => {
    const rows = [
      { asset: "a1", side: "buy", size: 10, price: 0.4, timestamp: 1000, title: "t", outcome: "Yes" },
      { asset: "a2", side: "UNKNOWN", size: 10, price: 0.4, timestamp: 1001, title: "t", outcome: "Yes" },
      { asset: "a3", side: "", size: 10, price: 0.4, timestamp: 1002, title: "t", outcome: "Yes" },
      { asset: "a4", size: 10, price: 0.4, timestamp: 1003, title: "t", outcome: "Yes" },
      { asset: "a5", side: "Sell", size: 10, price: 0.4, timestamp: 1004, title: "t", outcome: "Yes" },
    ];
    const events = normalizeSourceEvents(rows as never, WALLET);
    expect(events.map((e) => e.asset)).toEqual(["a1", "a5"]);
    expect(events.map((e) => e.side)).toEqual(["BUY", "SELL"]);
  });
});

describe("bounded resumable candidate research", () => {
  const candidates = [
    { id: "c3", handle: "c3" },
    { id: "c1", handle: "c1" },
    { id: "c2", handle: "c2" },
    { id: "c4", handle: "c4" },
  ];

  it("selects never-computed candidates first, then oldest-computed", () => {
    const map = new Map<string, string | null>([
      ["c1", "2026-08-16T10:00:00.000Z"],
      ["c2", "2026-08-15T10:00:00.000Z"],
      ["c3", null],
    ]);
    expect(selectResearchBatch(candidates, map, 3).map((c) => c.id)).toEqual(["c3", "c4", "c2"]);
  });

  it("progresses across repeated runs instead of restarting the universe", () => {
    const map = new Map<string, string | null>();
    const first = selectResearchBatch(candidates, map, 2).map((c) => c.id);
    for (const id of first) map.set(id, "2026-08-16T12:00:00.000Z");
    const second = selectResearchBatch(candidates, map, 2).map((c) => c.id);
    expect(second.some((id) => first.includes(id))).toBe(false);
  });

  it("keeps the batch and budget comfortably inside the 300s research lease", () => {
    expect(RESEARCH_BATCH_SIZE).toBeGreaterThan(0);
    expect(RESEARCH_BUDGET_MS).toBeLessThan(300_000);
    expect(budgetExhausted(0, RESEARCH_BUDGET_MS - 1)).toBe(false);
    expect(budgetExhausted(0, RESEARCH_BUDGET_MS)).toBe(true);
  });
});

describe("General Shadow bounded safe-resume guard", () => {
  it("keeps General Shadow polling disabled by default with a bounded catch-up budget", () => {
    expect(GENERAL_SHADOW_POLLING_ENABLED).toBe(false);
    expect(GENERAL_SHADOW_CATCHUP_PAGE_BUDGET).toBeGreaterThan(0);
    expect(GENERAL_SHADOW_CATCHUP_PAGE_BUDGET).toBeLessThanOrEqual(16);
  });

  it("fails closed once the bounded budget is exhausted, never returning a partial window", async () => {
    let pages = 0;
    const fetchPage = async () => {
      pages += 1;
      return Array.from({ length: PAGE_SIZE }, (_v, i) => ({ timestamp: 9_000_000 - i })) as never;
    };
    await expect(
      fetchUntilCheckpointCovered(fetchPage, 1, PAGE_SIZE, undefined, GENERAL_SHADOW_CATCHUP_PAGE_BUDGET),
    ).rejects.toBeInstanceOf(CatchupPageBudgetExceededError);
    expect(pages).toBe(GENERAL_SHADOW_CATCHUP_PAGE_BUDGET);
  });

  it("leaves V2/V3 catch-up unbounded (no page budget) and unaffected", async () => {
    let pages = 0;
    const fetchPage = async () => {
      pages += 1;
      // Coverage only proven well past the General Shadow budget.
      if (pages > GENERAL_SHADOW_CATCHUP_PAGE_BUDGET + 4) return [{ timestamp: 1 }] as never;
      return Array.from({ length: PAGE_SIZE }, () => ({ timestamp: 9_000_000 })) as never;
    };
    const out = await fetchUntilCheckpointCovered(fetchPage, 5_000_000, PAGE_SIZE);
    expect(out.pagesFetched).toBe(GENERAL_SHADOW_CATCHUP_PAGE_BUDGET + 5);
  });
});

describe("reconciliation repair writes are checked before any repaired alert", () => {
  it("throws on a failed source_position_state repair upsert and cannot reach the repaired alert path", () => {
    const src = readFileSync(new URL("./shadow.server.ts", import.meta.url), "utf8");
    const upsertIdx = src.indexOf('.from("source_position_state")\n      .upsert(');
    expect(upsertIdx).toBeGreaterThan(-1);
    const after = src.slice(upsertIdx, upsertIdx + 800);
    // The repair loop must inspect the returned error and throw before the
    // reconciliation_advanced / reconciliation_mismatch alerts are raised.
    expect(after).toMatch(/repairError/);
    expect(after).toMatch(/throw new Error\(`source_position_state repair failed/);
    const throwIdx = src.indexOf("source_position_state repair failed");
    for (const kind of ["reconciliation_advanced", "reconciliation_mismatch"]) {
      const alertIdx = src.indexOf(`"${kind}"`, upsertIdx);
      expect(alertIdx).toBeGreaterThan(throwIdx);
    }
  });
});
