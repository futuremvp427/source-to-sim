-- Task 12F / P1-G: real-Postgres proof for renew_sports_shadow_lease -- privilege
-- hardening AND the actual CAS/fencing semantics (G2/G3/G4/G5), against the ACTUAL
-- migrated database and the REAL acquire_worker_lease RPC (never mocked/mirrored).
-- Run via: psql -f supabase/tests/sports_shadow_lease_renewal.sql (after
-- `supabase db reset --local`)
BEGIN;

DO $$
DECLARE
  v_lock_id text := 'sports_shadow_lease_renewal_test';
  v_fence integer;
  v_new_fence integer;
  v_renewed boolean;
  v_oid oid;
  v_public_has_execute boolean;
  v_expires_before timestamptz;
  v_expires_after timestamptz;
BEGIN
  ------------------------------------------------------------------
  -- 1. PRIVILEGE HARDENING: PUBLIC/anon/authenticated denied, service_role allowed --
  -- real execution attempt, not just catalog inspection.
  ------------------------------------------------------------------
  v_oid := 'public.renew_sports_shadow_lease(text, text, integer, integer)'::regprocedure;

  SELECT EXISTS (
    SELECT 1 FROM pg_proc p, LATERAL aclexplode(COALESCE(p.proacl, acldefault('f', p.proowner))) a
    WHERE p.oid = v_oid AND a.grantee = 0 AND a.privilege_type = 'EXECUTE'
  ) INTO v_public_has_execute;
  IF v_public_has_execute THEN RAISE EXCEPTION 'PUBLIC must not have EXECUTE on renew_sports_shadow_lease'; END IF;
  IF has_function_privilege('anon', v_oid, 'EXECUTE') THEN RAISE EXCEPTION 'anon must not have EXECUTE on renew_sports_shadow_lease'; END IF;
  IF has_function_privilege('authenticated', v_oid, 'EXECUTE') THEN RAISE EXCEPTION 'authenticated must not have EXECUTE on renew_sports_shadow_lease'; END IF;
  IF NOT has_function_privilege('service_role', v_oid, 'EXECUTE') THEN RAISE EXCEPTION 'service_role must have EXECUTE on renew_sports_shadow_lease'; END IF;

  BEGIN
    SET LOCAL ROLE anon;
    PERFORM public.renew_sports_shadow_lease(v_lock_id, 'w1', 1, 60);
    RAISE EXCEPTION 'anon must not be able to call renew_sports_shadow_lease';
  EXCEPTION WHEN insufficient_privilege THEN
    RESET ROLE;
  END;

  ------------------------------------------------------------------
  -- 2. Acquire a real lease via the REAL (unmodified) acquire_worker_lease RPC.
  ------------------------------------------------------------------
  v_fence := public.acquire_worker_lease(v_lock_id, 'worker-a', 60);
  IF v_fence IS NULL THEN
    RAISE EXCEPTION 'expected acquire_worker_lease to succeed on a fresh lock id';
  END IF;

  SELECT lease_expires_at INTO v_expires_before FROM public.worker_status WHERE id = v_lock_id;

  ------------------------------------------------------------------
  -- 3. G2: a renewal with the current id/worker/fence before expiry succeeds and
  -- extends lease_expires_at, measured from the DATABASE's own now() (never a
  -- client-supplied timestamp).
  ------------------------------------------------------------------
  v_renewed := public.renew_sports_shadow_lease(v_lock_id, 'worker-a', v_fence, 60);
  IF NOT v_renewed THEN
    RAISE EXCEPTION 'expected renew_sports_shadow_lease to succeed for the current owner before expiry';
  END IF;

  SELECT lease_expires_at INTO v_expires_after FROM public.worker_status WHERE id = v_lock_id;
  IF v_expires_after <= v_expires_before THEN
    RAISE EXCEPTION 'expected lease_expires_at to be extended by a successful renewal';
  END IF;

  -- Renewal must not have bumped the fence -- it is the SAME owner, SAME fence,
  -- extended in place (only acquire_worker_lease ever bumps the fence).
  IF NOT EXISTS (SELECT 1 FROM public.worker_status WHERE id = v_lock_id AND fence = v_fence) THEN
    RAISE EXCEPTION 'HARD GATE VIOLATED: a successful renewal must not change the fence';
  END IF;

  ------------------------------------------------------------------
  -- 4. G3: a renewal after the lease has genuinely expired fails rather than
  -- resurrecting it. Directly age the row (equivalent to real time having passed) --
  -- the predicate is lease_expires_at > now(), so this proves the "cannot revive an
  -- already-expired lease" guarantee without waiting out a real TTL.
  ------------------------------------------------------------------
  UPDATE public.worker_status SET lease_expires_at = now() - interval '1 second' WHERE id = v_lock_id;

  v_renewed := public.renew_sports_shadow_lease(v_lock_id, 'worker-a', v_fence, 60);
  IF v_renewed THEN
    RAISE EXCEPTION 'HARD GATE VIOLATED: renewal succeeded on an already-expired lease';
  END IF;

  ------------------------------------------------------------------
  -- 5. G4: a new owner can now legitimately acquire (fence strictly increases), and the
  -- OLD worker's renewal (stale fence) fails against it.
  ------------------------------------------------------------------
  v_new_fence := public.acquire_worker_lease(v_lock_id, 'worker-b', 60);
  IF v_new_fence IS NULL OR v_new_fence <= v_fence THEN
    RAISE EXCEPTION 'expected a fresh acquire to succeed with a strictly greater fence after expiry';
  END IF;

  v_renewed := public.renew_sports_shadow_lease(v_lock_id, 'worker-a', v_fence, 60);
  IF v_renewed THEN
    RAISE EXCEPTION 'HARD GATE VIOLATED: a stale fence renewed against a newer owner';
  END IF;

  ------------------------------------------------------------------
  -- 6. G5: that stale renewal attempt must not have clobbered the new owner's lease.
  ------------------------------------------------------------------
  IF NOT EXISTS (
    SELECT 1 FROM public.worker_status
    WHERE id = v_lock_id AND worker_id = 'worker-b' AND fence = v_new_fence AND lease_expires_at > now()
  ) THEN
    RAISE EXCEPTION 'HARD GATE VIOLATED: the new owner''s lease was clobbered by a stale renewal attempt';
  END IF;

  RAISE NOTICE 'sports_shadow_lease_renewal contract passed';
END $$;

ROLLBACK;
