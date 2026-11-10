-- Harden reviewed SECURITY DEFINER functions whose bodies already schema-qualify
-- every application relation and qualify auth.uid(). PostgreSQL implicitly
-- searches pg_catalog for built-ins even when search_path is empty.
-- This migration changes function configuration only; it does not execute any
-- function or mutate application data.
--
-- Some historical overloads are absent in production. Resolve each signature
-- before ALTER so a missing optional overload cannot abort the whole migration.
DO $migration$
DECLARE
  v_signature text;
  v_function regprocedure;
BEGIN
  FOREACH v_signature IN ARRAY ARRAY[
    'public.get_channel_post_stats(uuid[], uuid)',
    'public.get_own_status_view_counts(uuid[])',
    'public.get_conversation_poll_vote_counts(uuid)',
    'public.get_poll_vote_counts_for_ids(uuid, uuid[])',
    'public.cast_poll_vote(uuid, uuid[])',
    'public.cast_poll_vote(uuid, uuid)',
    'public.create_conversation_poll(uuid, text, text[], timestamptz, boolean)',
    'public.create_conversation_poll(uuid, text, text[], timestamptz)',
    'public.set_pinned_message_snapshot()',
    'public.deliver_due_scheduled_messages(integer)'
  ] LOOP
    v_function := to_regprocedure(v_signature);
    IF v_function IS NOT NULL THEN
      EXECUTE format('ALTER FUNCTION %s SET search_path = %L', v_function, '');
    END IF;
  END LOOP;
END;
$migration$;
