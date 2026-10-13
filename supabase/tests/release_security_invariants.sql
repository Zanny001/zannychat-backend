-- Release-level catalog assertions for ZannyChat 1.2.3.
-- Run as a database owner after applying migrations through 0011.
-- These assertions verify installed policy/ACL shape, not real-user behavior.
do $$
declare
  fn record;
  n integer;
  bucket_public boolean;
begin
  -- All user-facing conversation data must have RLS enabled.
  if not (select relrowsecurity from pg_class where oid='public.conversations'::regclass) then
    raise exception 'RLS disabled on conversations';
  end if;
  if not (select relrowsecurity from pg_class where oid='public.conversation_participants'::regclass) then
    raise exception 'RLS disabled on conversation_participants';
  end if;
  if not (select relrowsecurity from pg_class where oid='public.messages'::regclass) then
    raise exception 'RLS disabled on messages';
  end if;
  if not (select relrowsecurity from pg_class where oid='public.message_reactions'::regclass) then
    raise exception 'RLS disabled on message_reactions';
  end if;

  -- The private membership helper must be SECURITY DEFINER with a pinned path,
  -- and it must not be executable by anonymous callers.
  select p.* into fn
  from pg_proc p join pg_namespace ns on ns.oid=p.pronamespace
  where p.oid='private.is_conversation_participant(uuid)'::regprocedure;
  if fn.oid is null or not fn.prosecdef then
    raise exception 'private membership helper missing or not SECURITY DEFINER';
  end if;
  if not ('search_path=pg_catalog' = any(coalesce(fn.proconfig, array[]::text[]))) then
    raise exception 'private membership helper search_path is not pinned';
  end if;
  if has_function_privilege('anon','private.is_conversation_participant(uuid)','EXECUTE') then
    raise exception 'anon can execute private membership helper';
  end if;
  if not has_function_privilege('authenticated','private.is_conversation_participant(uuid)','EXECUTE') then
    raise exception 'authenticated cannot execute membership helper used by RLS';
  end if;

  -- Block helper must remain restricted to authenticated callers and pin search_path.
  select p.* into fn
  from pg_proc p join pg_namespace ns on ns.oid=p.pronamespace
  where p.oid='public.is_blocked_in_conversation(uuid,uuid)'::regprocedure;
  if fn.oid is null or not fn.prosecdef then
    raise exception 'block-check helper missing or not SECURITY DEFINER';
  end if;
  if not ('search_path=pg_catalog' = any(coalesce(fn.proconfig, array[]::text[]))) then
    raise exception 'block-check helper search_path is not pinned';
  end if;
  if has_function_privilege('anon','public.is_blocked_in_conversation(uuid,uuid)','EXECUTE') then
    raise exception 'anon can execute block-check helper';
  end if;

  -- Ensure each expected core policy is present and uses the non-recursive helper.
  select count(*) into n from pg_policies
  where (schemaname='public' and tablename='conversations'
      and policyname='Members can view their conversations' and coalesce(qual,'') like '%is_conversation_participant%')
     or (schemaname='public' and tablename='conversation_participants'
      and policyname='Members can view fellow participants' and coalesce(qual,'') like '%is_conversation_participant%')
     or (schemaname='public' and tablename='messages'
      and policyname='Members can read messages in their conversations' and coalesce(qual,'') like '%is_conversation_participant%')
     or (schemaname='public' and tablename='messages'
      and policyname='Members can send messages in their conversations' and coalesce(with_check,'') like '%is_conversation_participant%')
     or (schemaname='public' and tablename='messages'
      and policyname='Senders can edit or delete their own messages'
      and coalesce(qual,'') like '%is_conversation_participant%' and coalesce(with_check,'') like '%is_conversation_participant%');
  if n <> 5 then raise exception 'expected 5 non-recursive core policies; found %', n; end if;

  -- Authenticated users must not be able to rewrite immutable identity columns.
  if has_column_privilege('authenticated','public.conversation_participants','conversation_id','UPDATE')
     or has_column_privilege('authenticated','public.conversation_participants','user_id','UPDATE') then
    raise exception 'participant identity columns remain updateable';
  end if;
  if has_column_privilege('authenticated','public.messages','conversation_id','UPDATE')
     or has_column_privilege('authenticated','public.messages','sender_id','UPDATE') then
    raise exception 'message identity columns remain updateable';
  end if;
  if not exists (select 1 from pg_trigger where tgrelid='public.message_reactions'::regclass
      and tgname='prevent_reaction_identity_change' and not tgisinternal and tgenabled <> 'D') then
    raise exception 'reaction identity trigger missing or disabled';
  end if;

  select public into bucket_public from storage.buckets where id='chat-media';
  if bucket_public is distinct from false then raise exception 'chat-media bucket is not private'; end if;
  if exists (select 1 from pg_policies where schemaname='storage' and tablename='objects'
      and policyname='Chat media is readable by anyone with the link') then
    raise exception 'legacy public chat-media policy remains';
  end if;
  if not exists (select 1 from pg_policies where schemaname='storage' and tablename='objects'
      and policyname='Chat media is readable by conversation participants'
      and coalesce(qual,'') like '%is_chat_media_conversation_member%') then
    raise exception 'private chat-media SELECT policy missing';
  end if;
  if not exists (select 1 from pg_policies where schemaname='storage' and tablename='objects'
      and policyname='Only conversation participants can upload chat media'
      and coalesce(with_check,'') like '%is_chat_media_conversation_member%') then
    raise exception 'private chat-media INSERT policy missing';
  end if;
end $$;

select 'ZannyChat release security invariants passed' as result;

-- Required integration tests with separate JWT identities (not replaced by the
-- catalog assertions above):
-- 1. Member can read own conversation/messages/reactions and download its media.
-- 2. Nonmember and anon cannot read conversation rows or download media.
-- 3. Member cannot alter participant identity, message sender/conversation, or
--    reaction message/user identity; reaction emoji upsert still succeeds.
-- 4. A blocked sender's message insert fails; an unrelated conversation works.
