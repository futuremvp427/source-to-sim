import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { describe, expect, it } from "vitest";

import { MASTER_CATEGORIES, isIncludedInMaster } from "./master-portfolio";

const here = dirname(fileURLToPath(import.meta.url));
const sql = readFileSync(resolve(here, "../../supabase/migrations/20260817054024_e221bb3f-f1bc-4271-b622-ce4f2a4dea06.sql"), "utf8");

describe("market_scope migration + BadTattoo seed", () => {
  it("adds market_scope as NOT NULL DEFAULT 'ALL' with an explicit allowlist", () => {
    expect(sql).toContain("ADD COLUMN IF NOT EXISTS market_scope text NOT NULL DEFAULT 'ALL'");
    expect(sql).toContain("CHECK (market_scope IN ('ALL', 'WEATHER', 'CRYPTO', 'MENTIONS', 'WORLD_POLITICS'))");
  });

  it("preserves legacy weather_only semantics instead of dropping the column", () => {
    expect(sql).toContain("WHERE weather_only = true");
    expect(sql).toContain("SET market_scope = 'WEATHER'");
    expect(sql).not.toMatch(/DROP COLUMN\s+weather_only/i);
  });

  it("seeds BadTattoo as a $380 dynamic-v1 CRYPTO simulated candidate with a fresh boundary", () => {
    expect(sql).toContain("'CANDIDATE: BadTattoo'");
    expect(sql).toContain("'0xa7011667f22c121c6cea7aab30192307c58c47cd'");
    expect(sql).toContain("'dynamic-v1'");
    expect(sql).toContain("'CRYPTO'");
    expect(sql).toContain("1786945086::bigint");
  });

  it("is idempotent: never resets an existing candidate row", () => {
    expect(sql).toContain("ON CONFLICT (name) DO NOTHING");
    expect(sql).toContain("WHERE NOT EXISTS (");
  });

  it("seeds no other wallet", () => {
    const wallets = [...sql.matchAll(/0x[a-f0-9]{40}/g)].map((m) => m[0]);
    expect(new Set(wallets)).toEqual(new Set(["0xa7011667f22c121c6cea7aab30192307c58c47cd"]));
  });

  it("keeps BadTattoo out of Master Portfolio totals", () => {
    expect(isIncludedInMaster("CANDIDATE: BadTattoo")).toBe(false);
    expect(MASTER_CATEGORIES.flatMap((c) => c.experimentNames)).toHaveLength(5);
  });
});
