-- Durable outbox cursor for actual paper BUY Telegram notifications.
--
-- Motivation: paper accounting can commit a BUY before a later best-effort
-- stage fails. A notification producer that trusts only the cycle summary can
-- therefore miss a real persisted BUY forever. This cursor scans the durable
-- paper_trades ledger instead. It is initialized at migration time so enabling
-- this feature does NOT replay the historical paper BUY backlog into Telegram.
--
-- The cursor is advanced only after alert rows for the returned batch have
-- been durably upserted. If the process dies before the advance, the same
-- batch is returned next time and alert dedup keys make the replay harmless.
-- Nothing here changes paper accounting, checkpoints, sizing, qualification,
-- or live-order state.

CREATE TABLE public.paper_buy_notification_cursor (
  cursor_name text PRIMARY KEY,
  last_created_at timestamptz NOT NULL,
  last_trade_id uuid NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.paper_buy_notification_cursor ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.paper_buy_notification_cursor FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE ON TABLE public.paper_buy_notification_cursor TO service_role;

-- The all-FF UUID makes the migration timestamp an exclusive boundary even if
-- a pre-existing trade happened to share that exact timestamp.
INSERT INTO public.paper_buy_notification_cursor (
  cursor_name,
  last_created_at,
  last_trade_id
)
VALUES (
  'telegram-paper-buy',
  statement_timestamp(),
  'ffffffff-ffff-ffff-ffff-ffffffffffff'::uuid
)
ON CONFLICT (cursor_name) DO NOTHING;

CREATE OR REPLACE FUNCTION public.get_pending_paper_buy_notification_trades(
  p_limit integer DEFAULT 120
)
RETURNS TABLE (
  trade_id uuid,
  experiment_id uuid,
  experiment_name text,
  event_key text,
  market_title text,
  outcome text,
  price numeric,
  shares numeric,
  notional numeric,
  cash_after numeric,
  source_ts bigint,
  created_at timestamptz
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_limit integer := LEAST(GREATEST(COALESCE(p_limit, 120), 1), 240);
BEGIN
  IF auth.role() IS NOT NULL AND auth.role() <> 'service_role' THEN
    RAISE EXCEPTION 'get_pending_paper_buy_notification_trades: service_role required'
      USING ERRCODE = '42501';
  END IF;

  RETURN QUERY
  SELECT
    pt.id,
    pt.experiment_id,
    pe.name,
    pt.event_key,
    pt.market_title,
    pt.outcome,
    pt.price,
    pt.shares,
    pt.notional,
    pt.cash_after,
    pt.source_ts,
    pt.created_at
  FROM public.paper_trades pt
  JOIN public.paper_experiments pe ON pe.id = pt.experiment_id
  CROSS JOIN public.paper_buy_notification_cursor c
  WHERE c.cursor_name = 'telegram-paper-buy'
    AND pt.action = 'BUY'
    AND (pt.created_at, pt.id) > (c.last_created_at, c.last_trade_id)
  ORDER BY pt.created_at ASC, pt.id ASC
  LIMIT v_limit;
END;
$$;

REVOKE ALL ON FUNCTION public.get_pending_paper_buy_notification_trades(integer)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.get_pending_paper_buy_notification_trades(integer)
  TO service_role;

CREATE OR REPLACE FUNCTION public.advance_paper_buy_notification_cursor(
  p_last_created_at timestamptz,
  p_last_trade_id uuid
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF auth.role() IS NOT NULL AND auth.role() <> 'service_role' THEN
    RAISE EXCEPTION 'advance_paper_buy_notification_cursor: service_role required'
      USING ERRCODE = '42501';
  END IF;

  UPDATE public.paper_buy_notification_cursor
  SET
    last_created_at = p_last_created_at,
    last_trade_id = p_last_trade_id,
    updated_at = now()
  WHERE cursor_name = 'telegram-paper-buy'
    AND (last_created_at, last_trade_id) < (p_last_created_at, p_last_trade_id);
END;
$$;

REVOKE ALL ON FUNCTION public.advance_paper_buy_notification_cursor(timestamptz, uuid)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.advance_paper_buy_notification_cursor(timestamptz, uuid)
  TO service_role;
