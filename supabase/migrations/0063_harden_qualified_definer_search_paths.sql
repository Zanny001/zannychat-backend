-- Harden reviewed SECURITY DEFINER functions whose bodies already schema-qualify
-- every application relation and qualify auth.uid(). PostgreSQL implicitly
-- searches pg_catalog for built-ins even when search_path is empty.
-- This migration changes function configuration only; it does not execute any
-- function or mutate application data.

ALTER FUNCTION public.get_channel_post_stats(uuid[], uuid) SET search_path = '';
ALTER FUNCTION public.get_own_status_view_counts(uuid[]) SET search_path = '';
ALTER FUNCTION public.get_conversation_poll_vote_counts(uuid) SET search_path = '';
ALTER FUNCTION public.get_poll_vote_counts_for_ids(uuid, uuid[]) SET search_path = '';
ALTER FUNCTION public.cast_poll_vote(uuid, uuid[]) SET search_path = '';
ALTER FUNCTION public.cast_poll_vote(uuid, uuid) SET search_path = '';
ALTER FUNCTION public.create_conversation_poll(uuid, text, text[], timestamptz, boolean) SET search_path = '';
ALTER FUNCTION public.create_conversation_poll(uuid, text, text[], timestamptz) SET search_path = '';
ALTER FUNCTION public.set_pinned_message_snapshot() SET search_path = '';
ALTER FUNCTION public.deliver_due_scheduled_messages(integer) SET search_path = '';
