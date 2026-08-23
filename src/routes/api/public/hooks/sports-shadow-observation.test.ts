import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

const source = readFileSync(new URL("./sports-shadow-observation.ts", import.meta.url), "utf8");

describe("sports shadow OBSERVATION job scheduler hook authorization contract", () => {
  it("keeps the mutating scheduler hook POST-only", () => {
    expect(source).toMatch(/handlers:\s*\{[\s\S]*?POST:\s*\(\{\s*request\s*\}\)\s*=>\s*handle\(request\)/);
    expect(source).not.toMatch(/\bGET\s*:/);
  });

  it("requires the dedicated SPORTS_SHADOW_HOOK_SECRET", () => {
    expect(source).toContain('process.env["SPORTS_SHADOW_HOOK_SECRET"]');
    expect(source).toContain("status: 401");
  });

  it("checks the secret via the dedicated fail-closed helper, not an inline comparison that could silently accept an empty/undefined expected value", () => {
    expect(source).toContain("checkSportsShadowSecret(provided, expected)");
  });

  it("reads the credential only from the dedicated x-sports-shadow-secret header", () => {
    expect(source).toContain('request.headers.get("x-sports-shadow-secret")');
  });

  it("never accepts the generic apikey header or a browser-visible Supabase key as a scheduler fallback", () => {
    expect(source).not.toContain('"apikey"');
    expect(source).not.toMatch(/SUPABASE_(?:ANON|PUBLISHABLE)_KEY/);
    expect(source).not.toMatch(/VITE_SUPABASE/);
    expect(source).not.toMatch(/PUBLIC_SUPABASE/);
  });

  it("validates config and fails closed before invoking the job", () => {
    expect(source).toContain("parseSportsShadowConfig(");
    expect(source).toMatch(/if\s*\(\s*!configResult\.ok\s*\)/);
  });

  it("never references live-trading, order-placement, or authenticated-credential identifiers", () => {
    expect(source).not.toMatch(/createOrder|submitOrder|cancelOrder|KALSHI_API_KEY|KALSHI_PRIVATE_KEY|LIVE_EXECUTION|PMUS_LIVE|KALSHI_LIVE|private[_-]?key/i);
  });

  it("never uses a timer/daemon/sleep-as-scheduling pattern", () => {
    expect(source).not.toMatch(/setInterval|while\s*\(\s*true\s*\)|setTimeout/);
  });

  it("CODEX P2-1: invokes runSportsShadowCycle with the 'observation' lane, never 'both' or 'source'", () => {
    expect(source).toMatch(/runSportsShadowCycle\(configResult\.config,\s*\{\},\s*"observation"\)/);
  });
});
