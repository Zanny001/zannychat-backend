-- Trigger functions are invoked by PostgreSQL through their trigger binding;
-- they must not be directly callable through the exposed PostgREST RPC surface.
BEGIN;
REVOKE ALL ON FUNCTION public.guard_call_session_group_room_link() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.guard_call_session_group_room_link() TO service_role;
COMMIT;
