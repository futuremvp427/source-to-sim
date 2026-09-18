import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

const BASE = readFileSync("supabase/migrations/20260918030000_sports_shadow_same_venue_kalshi_source.sql", "utf8");
const HARDENING = readFileSync("supabase/migrations/20260918031500_sports_shadow_same_venue_hardening.sql", "utf8");

describe("same-venue Kalshi schema contract", () => {
  it("enforces durable source identity with both unique invariants", () => {
    expect(BASE).toMatch(/event_key text NOT NULL UNIQUE/i);
    expect(BASE).toMatch(/UNIQUE \(trader_id, source_trade_id\)/i);
    expect(HARDENING).toMatch(/ON CONFLICT DO NOTHING/i);
    expect(HARDENING).toMatch(/same-venue source event identity collision/i);
  });

  it("recovers only stale PROCESSING claims and keeps concurrent claims SKIP LOCKED", () => {
    expect(HARDENING).toMatch(/status = 'PROCESSING'/);
    expect(HARDENING).toMatch(/claimed_at < now\(\) - interval '15 minutes'/);
    expect(HARDENING).toMatch(/FOR UPDATE SKIP LOCKED/i);
  });

  it("keeps gross realized P&L separate from fees before settlement", () => {
    const fn = HARDENING.slice(
      HARDENING.indexOf("CREATE OR REPLACE FUNCTION public.finalize_sports_shadow_kalshi_paper_fill"),
      HARDENING.indexOf("CREATE OR REPLACE FUNCTION public.find_open_sports_shadow_kalshi_positions"),
    );
    expect(fn).toMatch(/realized_pnl_usd = realized_pnl_usd\s*\+ \(COALESCE\(p_vwap, 0\) - COALESCE\(v_avg, 0\)\) \* v_sell/);
    expect(fn).not.toMatch(/realized_pnl_usd[\s\S]*- COALESCE\(p_fee_usd, 0\)/);
    expect(fn).toMatch(/fees_usd = fees_usd \+ COALESCE\(p_fee_usd, 0\)/);
  });

  it("persists settlement backoff and has an atomic terminal finalizer", () => {
    expect(HARDENING).toMatch(/ADD COLUMN IF NOT EXISTS next_check_at timestamptz/i);
    expect(HARDENING).toMatch(/ADD COLUMN IF NOT EXISTS check_attempt_count integer/i);
    expect(HARDENING).toMatch(/find_open_sports_shadow_kalshi_positions/);
    expect(HARDENING).toMatch(/finalize_sports_shadow_kalshi_settlement/);
    expect(HARDENING).toMatch(/IF p_settlement_status <> 'PENDING' THEN/);
    expect(HARDENING).toMatch(/status = 'CLOSED'/);
  });

  it("restricts same-venue SECURITY DEFINER RPC execution to service_role", () => {
    for (const fn of [
      "admit_sports_shadow_kalshi_source_event",
      "claim_sports_shadow_kalshi_source_events",
      "finalize_sports_shadow_kalshi_paper_fill",
      "find_open_sports_shadow_kalshi_positions",
      "finalize_sports_shadow_kalshi_settlement",
    ]) {
      expect(HARDENING).toContain(`REVOKE ALL ON FUNCTION public.${fn}`);
      expect(HARDENING).toContain(`GRANT EXECUTE ON FUNCTION public.${fn}`);
      expect(HARDENING).toContain("TO service_role;");
    }
  });
});
