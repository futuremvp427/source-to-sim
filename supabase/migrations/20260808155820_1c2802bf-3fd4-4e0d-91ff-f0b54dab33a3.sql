REVOKE ALL ON FUNCTION public.acquire_worker_lease(text, text, integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.acquire_worker_lease(text, text, integer) TO service_role;

REVOKE ALL ON FUNCTION public.process_source_event_atomic(text, text, integer, uuid, jsonb) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.process_source_event_atomic(text, text, integer, uuid, jsonb) TO service_role;

REVOKE ALL ON FUNCTION public.has_role(uuid, public.app_role) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.has_role(uuid, public.app_role) TO authenticated, service_role;