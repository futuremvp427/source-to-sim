-- Restore the existing server-only Sports Shadow contract. Supabase default
-- privileges granted public client roles access even though these tables have
-- RLS and were explicitly granted to service_role only by their own migrations.
-- Do not alter existing rows, RLS policies, RPC privileges or default privileges
-- for unrelated/future tables. Existing service_role grants are retained.
BEGIN;

REVOKE ALL PRIVILEGES ON TABLE
  public.sports_shadow_source_fills,
  public.sports_shadow_signals,
  public.sports_market_matches,
  public.sports_quote_observations,
  public.sports_shadow_wallet_cursor,
  public.sports_shadow_experiment_epochs,
  public.sports_shadow_source_sell_events,
  public.sports_shadow_venue_capability,
  public.sports_shadow_paper_fills,
  public.sports_shadow_paper_positions,
  public.sports_shadow_settlements,
  public.sports_shadow_telemetry_events,
  public.sports_shadow_integrity_audits,
  public.sports_shadow_alerts,
  public.sports_shadow_milestone_snapshots,
  public.sports_shadow_wallet_coverage,
  public.sports_shadow_lifecycle_triggers
FROM PUBLIC, anon, authenticated;

COMMIT;
