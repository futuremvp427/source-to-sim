CREATE INDEX IF NOT EXISTS copyability_observations_experiment_created_id_idx
  ON public.copyability_observations (experiment_id, created_at DESC, id DESC);

CREATE INDEX IF NOT EXISTS copyability_observations_experiment_id_asc_idx
  ON public.copyability_observations (experiment_id, id);

CREATE TABLE IF NOT EXISTS public.wallet_reconcile_leases (
  wallet text PRIMARY KEY,
  holder text NOT NULL,
  lease_expires_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);

GRANT ALL ON public.wallet_reconcile_leases TO service_role;

ALTER TABLE public.wallet_reconcile_leases ENABLE ROW LEVEL SECURITY;

CREATE OR REPLACE FUNCTION public.try_acquire_reconcile_lease(p_wallet text, p_holder text, p_seconds integer)
RETURNS boolean
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
AS $$
  WITH ins AS (
    INSERT INTO public.wallet_reconcile_leases (wallet, holder, lease_expires_at, updated_at)
    VALUES (lower(p_wallet), p_holder, now() + make_interval(secs => p_seconds), now())
    ON CONFLICT (wallet) DO UPDATE
      SET holder = p_holder,
          lease_expires_at = now() + make_interval(secs => p_seconds),
          updated_at = now()
      WHERE public.wallet_reconcile_leases.lease_expires_at <= now()
    RETURNING 1
  )
  SELECT EXISTS (SELECT 1 FROM ins);
$$;

CREATE OR REPLACE FUNCTION public.release_reconcile_lease(p_wallet text, p_holder text)
RETURNS void
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
AS $$
  UPDATE public.wallet_reconcile_leases
     SET lease_expires_at = now() - interval '1 second',
         updated_at = now()
   WHERE wallet = lower(p_wallet)
     AND holder = p_holder;
$$;

REVOKE ALL ON FUNCTION public.try_acquire_reconcile_lease(text, text, integer) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.release_reconcile_lease(text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.try_acquire_reconcile_lease(text, text, integer) TO service_role;
GRANT EXECUTE ON FUNCTION public.release_reconcile_lease(text, text) TO service_role;