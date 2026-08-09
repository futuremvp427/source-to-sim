import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { describe, expect, it } from "vitest";

const here = dirname(fileURLToPath(import.meta.url));
const migrationPath = resolve(
  here,
  "../../supabase/migrations/20260809164000_fix_settlement_rpc_realized_pnl_ambiguity.sql",
);
const sql = readFileSync(migrationPath, "utf8");

describe("apply_verified_paper_settlement SQL", () => {
  it("qualifies realized_pnl reads so the RETURNS TABLE output variable cannot shadow table columns", () => {
    expect(sql).toContain("realized_pnl = round(pp.realized_pnl + v_realized, 2)");
    expect(sql).toContain("realized_pnl = round(pe.realized_pnl + v_realized, 2)");
    expect(sql).not.toMatch(/realized_pnl\s*=\s*round\(realized_pnl\s*\+/);
  });

  it("preserves the atomic idempotent settlement write path", () => {
    expect(sql).toContain("FOR UPDATE");
    expect(sql).toContain("ON CONFLICT (experiment_id, asset) DO NOTHING");
    expect(sql).toContain("RETURN QUERY SELECT true, v_payout, v_realized");
  });
});
