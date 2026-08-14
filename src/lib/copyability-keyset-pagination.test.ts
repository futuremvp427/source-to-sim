import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import { fetchAllRowsAfterId } from "./db-pagination";

/**
 * Production evidence: a `.range()` (OFFSET) page at offset 50k of one
 * experiment's copyability history took 22s against an 8s role
 * statement_timeout, even with a matching index. Full-history copyability reads
 * must therefore page by key, never by offset.
 */
describe("copyability full-history reads use keyset pagination", () => {
  const sources = [
    "src/lib/copyability/observe.server.ts",
    "src/lib/general-shadow.server.ts",
  ];

  for (const file of sources) {
    it(`${file} pages copyability_observations by id, not by offset`, () => {
      const src = readFileSync(file, "utf8");
      const blocks = src.split('.from("copyability_observations")').slice(1);
      const fullHistory = blocks.filter((b) => b.slice(0, 400).includes("fillable"));
      expect(fullHistory.length).toBeGreaterThanOrEqual(1);
      for (const block of fullHistory) {
        const head = block.slice(0, 400);
        expect(head).not.toContain(".range(");
        expect(head).toContain('.gt("id", afterId)');
      }
    });
  }

  it("walks every page by the last seen id and reports completeness", async () => {
    const all = Array.from({ length: 7 }, (_, i) => ({ id: `id-${i}` }));
    const seen: (string | null)[] = [];
    const result = await fetchAllRowsAfterId<{ id: string }>(
      async (afterId, limit) => {
        seen.push(afterId);
        const start = afterId === null ? 0 : all.findIndex((r) => r.id === afterId) + 1;
        return all.slice(start, start + limit);
      },
      { pageRows: 3 },
    );
    expect(result.rows.map((r) => r.id)).toEqual(all.map((r) => r.id));
    expect(seen).toEqual([null, "id-2", "id-5"]);
    expect(result.complete).toBe(true);
  });

  it("marks a read incomplete when the page cap is hit", async () => {
    const result = await fetchAllRowsAfterId<{ id: string }>(
      async () => [{ id: "a" }, { id: "b" }],
      { pageRows: 2, maxPages: 3 },
    );
    expect(result.complete).toBe(false);
    expect(result.pages).toBe(3);
  });
});
