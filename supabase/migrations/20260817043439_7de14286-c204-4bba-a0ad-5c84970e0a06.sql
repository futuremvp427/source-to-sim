create or replace function public.paper_trade_decision_stats(p_experiment_id uuid)
returns jsonb
language sql
stable
security definer
set search_path = public
as $$
  with decisions as (
    select action, reason, notional, source_ts
    from public.paper_trades
    where experiment_id = p_experiment_id
      and action <> 'SETTLEMENT'
  ), reasons as (
    select coalesce(nullif(btrim(split_part(coalesce(reason, 'Unspecified'), '(', 1)), ''), 'Unspecified') as reason,
           count(*) as count
    from decisions
    where action = 'SKIP'
    group by 1
    order by count(*) desc, 1 asc
    limit 3
  )
  select jsonb_build_object(
    'eligible_decisions', (select count(*) from decisions),
    'buys', (select count(*) from decisions where action = 'BUY'),
    'sells', (select count(*) from decisions where action = 'SELL'),
    'skips', (select count(*) from decisions where action = 'SKIP'),
    'avg_buy_usd', (select avg(notional) from decisions where action = 'BUY' and notional > 0),
    'avg_sell_usd', (select avg(notional) from decisions where action = 'SELL' and notional > 0),
    'last_source_ts', (select max(source_ts) from decisions),
    'skip_reasons', coalesce(
      (select jsonb_agg(jsonb_build_object('reason', reason, 'count', count)) from reasons),
      '[]'::jsonb
    )
  )
$$;

revoke all on function public.paper_trade_decision_stats(uuid) from public;
grant execute on function public.paper_trade_decision_stats(uuid) to service_role;