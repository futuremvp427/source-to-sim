import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { describe, expect, it } from "vitest";

const here = dirname(fileURLToPath(import.meta.url));
const migrationPath = resolve(
  here,
  "../../supabase/migrations/20260814131949_581d6f0d-e74c-4d5c-a177-ff0db7b7eb1b.sql",
);
const sql = readFileSync(migrationPath, "utf8");

describe("get_pending_experiment_source_events SQL", () => {
  it("drives an ordered source_events scan with a correlated consumption probe", () => {
    expect(sql).toMatch(/CROSS JOIN LATERAL/i);
    expect(sql).toMatch(/ORDER BY se\.source_ts ASC, se\.event_key ASC/i);
    expect(sql).toMatch(
      /NOT EXISTS \(\s*SELECT 1\s*FROM public\.experiment_event_state ees\s*WHERE ees\.experiment_id = pe\.id\s*AND ees\.source_event_id = se\.id/i,
    );
  });

  it("keeps the bounded limit semantics unchanged", () => {
    expect(sql).toContain("LIMIT GREATEST(1, LEAST(COALESCE(p_limit, 300), 2000))");
  });

  it("never reintroduces wallet-global processed_at consumption", () => {
    expect(sql).not.toMatch(/processed_at/i);
  });

  it("preserves the security and permission envelope", () => {
    expect(sql).toMatch(/SECURITY DEFINER/i);
    expect(sql).toMatch(/SET search_path TO 'public'/i);
    expect(sql).toMatch(/GRANT EXECUTE ON FUNCTION public\.get_pending_experiment_source_events\(uuid, integer\) TO service_role/i);
    for (const role of ["PUBLIC", "anon", "authenticated"]) {
      expect(sql).toContain(
        `REVOKE ALL ON FUNCTION public.get_pending_experiment_source_events(uuid, integer) FROM ${role}`,
      );
    }
  });

  it("removes only the duplicate source_events index and keeps the phase-1 ordered index", () => {
    expect(sql).toContain("DROP INDEX IF EXISTS public.source_events_wallet_ts_key_idx");
    expect(sql).not.toMatch(/DROP INDEX[^\n]*source_events_wallet_order_idx/i);
  });
});