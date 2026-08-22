-- FINAL BUILD, Part 2: real-Postgres proof for tuple_prefix (generated column) and
-- count_durable_ordinal_fills (grouped bounded RPC) against the ACTUAL migrated
-- database. Run via: psql -f supabase/tests/sports_shadow_tuple_prefix.sql (after
-- `supabase db reset --local`)
BEGIN;

DO $$
DECLARE
  v_oid oid;
  v_public_has_execute boolean;
  -- Includes the trailing '#' -- matches source-poll.server.ts's ordinalPrefix()
  -- convention (eventKey.slice(0, eventKey.lastIndexOf("#") + 1)) exactly.
  v_prefix_a text := 'ord:0xdeadbeef:0xasset1:BUY:1700000000:100:0.50#';
  v_prefix_b text := 'ord:0xdeadbeef:0xasset1:BUY:1700000001:200:0.60#';
  v_count bigint;
  v_null_count integer;
BEGIN
  ------------------------------------------------------------------
  -- A. tuple_prefix is populated ONLY for degraded ("ord:...#N") keys, and correctly
  -- strips exactly the trailing "#N" ordinal suffix.
  ------------------------------------------------------------------
  INSERT INTO public.sports_shadow_source_fills (event_key, wallet, asset, side, source_ts, identity_basis)
  VALUES
    (v_prefix_a || '0', '0xtest-tp', '0xasset1', 'BUY', 1700000000, 'tx_hash_ordinal'),
    (v_prefix_a || '1', '0xtest-tp', '0xasset1', 'BUY', 1700000000, 'tx_hash_ordinal'),
    (v_prefix_a || '12', '0xtest-tp', '0xasset1', 'BUY', 1700000000, 'tx_hash_ordinal'),
    (v_prefix_b || '0', '0xtest-tp', '0xasset1', 'BUY', 1700000001, 'tx_hash_ordinal'),
    ('sid:native-1', '0xtest-tp', '0xasset1', 'BUY', 1700000002, 'source_id'),
    ('tx:0xhash:5', '0xtest-tp', '0xasset1', 'BUY', 1700000003, 'tx_hash_log_index');

  IF (SELECT tuple_prefix FROM public.sports_shadow_source_fills WHERE event_key = v_prefix_a || '0') <> v_prefix_a THEN
    RAISE EXCEPTION 'tuple_prefix must keep the trailing # and strip only the ordinal digits after it, got %',
      (SELECT tuple_prefix FROM public.sports_shadow_source_fills WHERE event_key = v_prefix_a || '0');
  END IF;
  IF (SELECT tuple_prefix FROM public.sports_shadow_source_fills WHERE event_key = v_prefix_a || '12') <> v_prefix_a THEN
    RAISE EXCEPTION 'tuple_prefix must be identical across every #N sibling of the same physical fill (double-digit-safe)';
  END IF;

  SELECT count(*) INTO v_null_count
  FROM public.sports_shadow_source_fills
  WHERE event_key IN ('sid:native-1', 'tx:0xhash:5') AND tuple_prefix IS NOT NULL;
  IF v_null_count <> 0 THEN
    RAISE EXCEPTION 'tuple_prefix must be NULL for native-id and tx-hash/log-index keys -- reliable identity never needs prefix counting';
  END IF;

  ------------------------------------------------------------------
  -- B. tuple_prefix cannot be written directly (GENERATED ALWAYS, not BY DEFAULT) --
  -- proves it can never drift from event_key via a stray direct INSERT/UPDATE.
  ------------------------------------------------------------------
  BEGIN
    INSERT INTO public.sports_shadow_source_fills (event_key, wallet, asset, side, source_ts, identity_basis, tuple_prefix)
    VALUES ('ord:should-fail#0', '0xtest-tp', '0xasset1', 'BUY', 1, 'tx_hash_ordinal', 'attacker-supplied-value');
    RAISE EXCEPTION 'expected a GENERATED ALWAYS column to reject a direct INSERT value, but it succeeded';
  EXCEPTION
    WHEN OTHERS THEN
      -- SQLSTATE 428C9 (generated_always) is Postgres's own dedicated error class for
      -- exactly this case -- robust across wording/version, unlike matching SQLERRM text.
      IF SQLSTATE <> '428C9' THEN
        RAISE EXCEPTION 'expected SQLSTATE 428C9 (generated_always), got % (%)', SQLSTATE, SQLERRM;
      END IF;
  END;

  ------------------------------------------------------------------
  -- C. count_durable_ordinal_fills: privilege hardening.
  ------------------------------------------------------------------
  v_oid := 'public.count_durable_ordinal_fills(text, text[])'::regprocedure;

  SELECT EXISTS (
    SELECT 1 FROM pg_proc p, LATERAL aclexplode(COALESCE(p.proacl, acldefault('f', p.proowner))) a
    WHERE p.oid = v_oid AND a.grantee = 0 AND a.privilege_type = 'EXECUTE'
  ) INTO v_public_has_execute;
  IF v_public_has_execute THEN RAISE EXCEPTION 'PUBLIC must not have EXECUTE on count_durable_ordinal_fills'; END IF;
  IF has_function_privilege('anon', v_oid, 'EXECUTE') THEN RAISE EXCEPTION 'anon must not have EXECUTE on count_durable_ordinal_fills'; END IF;
  IF has_function_privilege('authenticated', v_oid, 'EXECUTE') THEN RAISE EXCEPTION 'authenticated must not have EXECUTE on count_durable_ordinal_fills'; END IF;
  IF NOT has_function_privilege('service_role', v_oid, 'EXECUTE') THEN RAISE EXCEPTION 'service_role must have EXECUTE on count_durable_ordinal_fills'; END IF;

  ------------------------------------------------------------------
  -- D. count_durable_ordinal_fills: exact grouped counts across multiple prefixes in
  -- ONE call, absent-prefix-means-zero, and wallet-scoping.
  ------------------------------------------------------------------
  SELECT fill_count INTO v_count FROM public.count_durable_ordinal_fills('0xtest-tp', ARRAY[v_prefix_a]) WHERE tuple_prefix = v_prefix_a;
  IF v_count <> 3 THEN RAISE EXCEPTION 'expected prefix A to have durable count 3, got %', v_count; END IF;

  SELECT fill_count INTO v_count FROM public.count_durable_ordinal_fills('0xtest-tp', ARRAY[v_prefix_b]) WHERE tuple_prefix = v_prefix_b;
  IF v_count <> 1 THEN RAISE EXCEPTION 'expected prefix B to have durable count 1, got %', v_count; END IF;

  IF EXISTS (SELECT 1 FROM public.count_durable_ordinal_fills('0xtest-tp', ARRAY['no-such-prefix'])) THEN
    RAISE EXCEPTION 'a prefix with zero durable rows must be ABSENT from the result set (caller treats absence as 0), not a zero-count row';
  END IF;

  IF EXISTS (SELECT 1 FROM public.count_durable_ordinal_fills('0xsome-other-wallet', ARRAY[v_prefix_a])) THEN
    RAISE EXCEPTION 'count_durable_ordinal_fills must be scoped to the requested wallet -- a different wallet must never see these rows counted';
  END IF;

  -- Multiple prefixes in ONE call (the entire point of this migration: bounded to ONE
  -- grouped query per page, not one query per prefix).
  IF (SELECT count(*) FROM public.count_durable_ordinal_fills('0xtest-tp', ARRAY[v_prefix_a, v_prefix_b])) <> 2 THEN
    RAISE EXCEPTION 'expected exactly 2 grouped rows back for 2 requested prefixes with durable rows';
  END IF;

  ------------------------------------------------------------------
  -- E. Index exists (partial, on wallet + tuple_prefix WHERE NOT NULL).
  ------------------------------------------------------------------
  IF to_regclass('public.sports_shadow_source_fills_wallet_tuple_prefix_idx') IS NULL THEN
    RAISE EXCEPTION 'expected index sports_shadow_source_fills_wallet_tuple_prefix_idx to exist';
  END IF;

  RAISE NOTICE 'sports_shadow_tuple_prefix.sql: all assertions passed';
END $$;

ROLLBACK;
