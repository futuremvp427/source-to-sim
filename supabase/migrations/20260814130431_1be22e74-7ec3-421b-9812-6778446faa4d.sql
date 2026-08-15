CREATE INDEX IF NOT EXISTS source_events_wallet_ts_key_idx
  ON public.source_events (wallet, source_ts ASC, event_key ASC);