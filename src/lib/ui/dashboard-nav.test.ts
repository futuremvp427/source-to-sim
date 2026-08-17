import { describe, expect, it } from "vitest";

import { TABS } from "@/components/mirror/shell";

describe("dashboard navigation", () => {
  it("keeps research and system diagnostics reachable, separate from the portfolio", () => {
    const keys = TABS.map((t) => t.key);
    expect(keys).toEqual(["overview", "strategies", "activity", "research", "system"]);
    // Research and System must not be merged into the master portfolio screens.
    expect(keys.indexOf("research")).toBeGreaterThan(keys.indexOf("overview"));
    expect(keys).toContain("system");
  });
});