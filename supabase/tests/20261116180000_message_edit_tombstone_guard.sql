-- Catalog/ACL assertions for the message edit tombstone guard.
-- Run as a database owner after migration 20261116180000.
DO $$
DECLARE
  v_policy record;
  v_function record;
  v_column text;
BEGIN
  SELECT qual, with_check INTO v_policy
  FROM pg_policies
  WHERE schemaname = 'public'
    AND tablename = 'messages'
    AND policyname = 'Senders can edit active messages in their conversations'
    AND cmd = 'UPDATE';

  IF v_policy.qual IS NULL OR v_policy.with_check IS NULL THEN
    RAISE EXCEPTION 'active-message UPDATE policy is missing USING or WITH CHECK';
  END IF;
  IF position('DELETED_AT IS NULL' IN upper(v_policy.qual)) = 0
     OR position('DELETED_AT IS NULL' IN upper(v_policy.with_check)) = 0 THEN
    RAISE EXCEPTION 'message UPDATE policy does not exclude retracted messages';
  END IF;
  IF position('IS_CONVERSATION_MEMBER' IN upper(v_policy.qual)) = 0
     OR position('IS_CONVERSATION_MEMBER' IN upper(v_policy.with_check)) = 0 THEN
    RAISE EXCEPTION 'message UPDATE policy is not conversation-member scoped';
  END IF;

  SELECT p.* INTO v_function
  FROM pg_proc p
  JOIN pg_namespace n ON n.oid = p.pronamespace
  WHERE n.nspname = 'private'
    AND p.proname = 'guard_message_edit_integrity'
    AND pg_get_function_identity_arguments(p.oid) = '';

  IF v_function.oid IS NULL OR v_function.prosecdef THEN
    RAISE EXCEPTION 'message edit guard must exist and run as invoker';
  END IF;
  IF NOT ('search_path=""' = ANY(COALESCE(v_function.proconfig, ARRAY[]::text[]))) THEN
    RAISE EXCEPTION 'message edit guard search_path is not pinned';
  END IF;
  IF has_function_privilege('anon', 'private.guard_message_edit_integrity()', 'EXECUTE')
     OR has_function_privilege('authenticated', 'private.guard_message_edit_integrity()', 'EXECUTE') THEN
    RAISE EXCEPTION 'client roles must not execute the message edit trigger function directly';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger
    WHERE tgrelid = 'public.messages'::regclass
      AND tgname = 'guard_message_edit_integrity'
      AND NOT tgisinternal
      AND tgenabled <> 'D'
  ) THEN
    RAISE EXCEPTION 'message edit guard trigger is missing or disabled';
  END IF;

  IF NOT has_column_privilege('authenticated', 'public.messages', 'text', 'UPDATE')
     OR NOT has_column_privilege('authenticated', 'public.messages', 'edited_at', 'UPDATE') THEN
    RAISE EXCEPTION 'authenticated message edit column grants are missing';
  END IF;
  FOREACH v_column IN ARRAY ARRAY[
    'id', 'conversation_id', 'sender_id', 'created_at', 'reply_to_id',
    'media_url', 'media_type', 'media_name', 'media_size',
    'media_duration', 'shared_user_id', 'deleted_at'
  ] LOOP
    IF has_column_privilege('authenticated', 'public.messages', v_column, 'UPDATE') THEN
      RAISE EXCEPTION 'authenticated unexpectedly has UPDATE on messages.%', v_column;
    END IF;
  END LOOP;
END;
$$;

SELECT 'message edit tombstone guard catalog checks passed' AS result;

-- Two-account integration checks still required on a seeded test database:
-- 1. Sender can edit text on an active message in a conversation they belong to.
-- 2. A sender cannot edit a retracted message to restore its text.
-- 3. A sender cannot forge edited_at without changing text; text edits receive a DB timestamp.
-- 4. A nonmember cannot edit another user's message.
