import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { describe, expect, it } from "vitest";

const here = dirname(fileURLToPath(import.meta.url));
const migrationPath = resolve(
  here,
  "../../supabase/migrations/20260814140000_pending_event_keyonly_scan.sql",
);
const sql = readFileSync(migrationPath, "utf8");

describe("pending-event key-only prefix scan", () => {
  it("materializes a narrow key-only candidate set before fetching wide payload rows", () => {
    expect(sql).toMatch(/pending_keys AS MATERIALIZED/i);
    expect(sql).toMatch(/SELECT\s+exp\.wallet,\s+se\.source_ts,\s+se\.event_key/i);
    expect(sql).toMatch(/FROM pending_keys pending\s+JOIN public\.source_events se/i);
  });

  it("uses experiment-scoped event_key identity for the long prefix probe", () => {
    expect(sql).toMatch(
      /FROM public\.experiment_event_state ees\s+WHERE ees\.experiment_id = exp\.id\s+AND ees\.event_key = se\.event_key/i,
    );
  });

  it("retains a bounded source_event_id defensive re-check over the final result", () => {
    expect(sql).toMatch(
      /WHERE ees\.experiment_id = p_experiment_id\s+AND ees\.source_event_id = se\.id/i,
    );
  });

  it("preserves earliest-first ordering and the existing limit clamp", () => {
    expect(sql).toContain("ORDER BY se.source_ts ASC, se.event_key ASC");
    expect(sql).toContain("LIMIT GREATEST(1, LEAST(COALESCE(p_limit, 300), 2000))");
    expect(sql).toContain("ORDER BY pending.source_ts ASC, pending.event_key ASC");
  });

  it("does not add indexes, cursors, processed_at gates, or accounting mutations", () => {
    expect(sql).not.toMatch(/CREATE\s+INDEX/i);
    expect(sql).not.toMatch(/ALTER\s+TABLE/i);
    expect(sql).not.toMatch(/processed_at/i);
    expect(sql).not.toMatch(/paper_trades|paper_positions|paper_settlements|cash\s*=|realized_pnl\s*=/i);
  });

  it("preserves the service-role-only permission envelope", () => {
    expect(sql).toMatch(/SECURITY DEFINER/i);
    expect(sql).toMatch(/SET search_path TO 'public'/i);
    expect(sql).toMatch(/GRANT EXECUTE ON FUNCTION public\.get_pending_experiment_source_events\(uuid, integer\) TO service_role/i);
    for (const role of ["PUBLIC", "anon", "authenticated"]) {
      expect(sql).toContain(
        `REVOKE ALL ON FUNCTION public.get_pending_experiment_source_events(uuid, integer) FROM ${role}`,
      );
    }
  });
});
