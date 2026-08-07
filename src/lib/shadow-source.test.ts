import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const src = readFileSync(new URL("./shadow.server.ts", import.meta.url), "utf8");

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
