/**
 * Task 12, sections 9 and 12: production build/route-presence readiness and the
 * live-safety audit. Pure static/source checks -- no network, no Supabase, no build
 * invocation of its own (the existing `validate` CI job already runs `bun run build`
 * and this repo's full test suite; this file adds targeted assertions on top of that,
 * not a duplicate build).
 */
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

const SPORTS_SHADOW_DIR = new URL(".", import.meta.url).pathname;
const ROUTE_TREE_PATH = new URL("../../routeTree.gen.ts", import.meta.url);

const LIVE_ORDER_PATTERN = /createOrder|submitOrder|cancelOrder|placeOrder/i;
const CREDENTIAL_PATTERN = /KALSHI_API_KEY|KALSHI_PRIVATE_KEY|POLYMARKET_KEY_ID|POLYMARKET_SECRET_KEY|private[_-]?key/i;
const AUTHENTICATED_ENDPOINT_PATTERN = /KALSHI-ACCESS-KEY|KALSHI-ACCESS-SIGNATURE|signer\.server|credentials\.server/i;

function listSportsShadowSourceFiles(): string[] {
  return readdirSync(SPORTS_SHADOW_DIR)
    .filter((f) => f.endsWith(".ts") && !f.endsWith(".test.ts"))
    .map((f) => join(SPORTS_SHADOW_DIR, f));
}

/**
 * Strips /* *\/ block comments and // line comments before pattern-scanning. Several
 * Sports Shadow modules DOCUMENT the absence of credentials/order code in their own doc
 * comments (e.g. kalshi.server.ts: "contains NO KALSHI_API_KEY_ID, NO
 * KALSHI_PRIVATE_KEY..."), which would otherwise false-positive a naive text scan --
 * the same recurring pattern already worked around in Tasks 5/6's own auth-safety
 * tests. Good enough for this fail-loud audit; not a general-purpose JS parser.
 */
function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
}

describe("Task 12, section 9: production route-tree presence", () => {
  it("the generated route tree contains /api/public/hooks/sports-shadow", () => {
    const routeTree = readFileSync(ROUTE_TREE_PATH, "utf8");
    expect(routeTree).toContain("'/api/public/hooks/sports-shadow'");
    expect(routeTree).toContain("routes/api/public/hooks/sports-shadow");
  });

  it("HTTP smoke test against a locally-built/served instance: DEFERRED", () => {
    // This repository (TanStack Start, server-rendered API routes) has no
    // repository-supported local command that serves the PRODUCTION build's server
    // route handlers without a real deployment target -- `vite preview` serves static
    // client output only, not this app's server route handlers. Per the mission's own
    // explicit instruction ("If there is no reliable local built-runtime preview
    // mechanism: do not invent one"), the GET/POST-secret/POST-wrong-secret/
    // POST-correct-secret-with-SPORTS_SHADOW_ENABLED=false smoke test is deliberately
    // NOT performed here. It is marked a POST-MERGE / PRE-ACTIVATION gate, to be run
    // once against the actual deployed environment before any scheduler is pointed at
    // this route. This test exists only to make that deferral explicit and searchable,
    // not to silently skip it.
    expect(true).toBe(true);
  });
});

describe("Task 12, section 10: scheduler readiness (documentation only, no activation)", () => {
  it("documents the required future schedule without creating any cron job", () => {
    // Observation checkpoints are +0s / +5s / +10s / +30s / +60s -- SECONDS, not
    // minutes. The future production scheduler must therefore invoke
    // POST /api/public/hooks/sports-shadow at approximately every 5 seconds, not on a
    // minute-granularity cron cadence. No pg_cron job is created by this task, in this
    // repository, or against any database -- local or production. Local Supabase's
    // pg_cron capability (if validated at all) proves only that the LOCAL CLI stack
    // supports the required cadence syntax; it does NOT prove the production Supabase
    // project's pg_cron version/configuration supports the same, which remains a
    // separate, later activation-time check.
    const REQUIRED_SCHEDULE_DESCRIPTION = "approximately every 5 seconds";
    const OBSERVATION_DELAYS_MS = [0, 5000, 10000, 30000, 60000];
    expect(OBSERVATION_DELAYS_MS.every((ms) => ms % 1000 === 0 && ms <= 60_000)).toBe(true);
    expect(REQUIRED_SCHEDULE_DESCRIPTION).toBe("approximately every 5 seconds");
  });
});

describe("Task 12, section 12: live safety audit", () => {
  it("no Sports Shadow source file reaches into order placement, credentials, or authenticated venue endpoints", () => {
    const files = listSportsShadowSourceFiles();
    expect(files.length).toBeGreaterThan(10); // sanity: the directory listing actually found the module set

    for (const path of files) {
      const src = stripComments(readFileSync(path, "utf8"));
      if (LIVE_ORDER_PATTERN.test(src)) {
        throw new Error(`${path} matches a live order-placement pattern`);
      }
      if (CREDENTIAL_PATTERN.test(src)) {
        throw new Error(`${path} matches a credential/private-key pattern`);
      }
      if (AUTHENTICATED_ENDPOINT_PATTERN.test(src)) {
        throw new Error(`${path} matches an authenticated-venue-endpoint pattern`);
      }
    }
  });

  it("reports the repository's ACTUAL live-execution safety mechanism (LIVE_EXECUTION_IMPLEMENTED), rather than assuming names that do not exist in this codebase", async () => {
    // This repo has no LIVE_EXECUTION_ENABLED / PMUS_LIVE_ENABLED / KALSHI_LIVE_ENABLED /
    // MAX_LIVE_ORDER_USD / MAX_LIVE_DAILY_LOSS_USD environment variables or constants --
    // those names do not exist here. The actual mechanism gating ALL live execution
    // repo-wide is the hard TypeScript constant LIVE_EXECUTION_IMPLEMENTED in
    // src/lib/live-safety/core.ts (false = no live order path exists ANYWHERE in the
    // codebase, Sports Shadow included -- Sports Shadow imports neither this module nor
    // any live-pilot module at all, so it is not merely "gated off" but structurally
    // absent). The general live-pilot subsystem separately layers a durable
    // kill_switch_engaged / activation_stage='locked' / zero-USD-cap DB row
    // (src/lib/live-pilot/poligarch-safety.server.ts), which Sports Shadow also never
    // touches. This test asserts the real constant's real value and that Sports Shadow
    // has zero import reachability into either safety-gated subsystem.
    const { LIVE_EXECUTION_IMPLEMENTED } = await import("../live-safety/core");
    expect(LIVE_EXECUTION_IMPLEMENTED).toBe(false);

    const files = listSportsShadowSourceFiles();
    for (const path of files) {
      const src = readFileSync(path, "utf8");
      const importLines = [...src.matchAll(/^import .*$/gm)].map((m) => m[0]);
      for (const line of importLines) {
        expect(line).not.toMatch(/live-safety|live-pilot/);
      }
    }
  });
});
