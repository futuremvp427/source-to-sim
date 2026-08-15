REVOKE ALL ON FUNCTION public.try_acquire_reconcile_lease(text, text, integer) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.release_reconcile_lease(text, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.try_acquire_reconcile_lease(text, text, integer) TO service_role;
GRANT EXECUTE ON FUNCTION public.release_reconcile_lease(text, text) TO service_role;