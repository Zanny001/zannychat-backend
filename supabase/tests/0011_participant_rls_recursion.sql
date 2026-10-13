-- Catalog assertions for migration 0011. These verify policy wiring only;
-- member/nonmember behavior must still be tested with separate JWT identities.
do $$
declare
  policy_count integer;
begin
  if not exists (
    select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'private' and p.proname = 'is_conversation_participant'
      and p.prosecdef
  ) then
    raise exception 'expected SECURITY DEFINER participant helper';
  end if;

  if has_function_privilege('anon', 'private.is_conversation_participant(uuid)', 'EXECUTE') then
    raise exception 'anonymous role must not execute participant helper';
  end if;

  select count(*) into policy_count from pg_policies
  where (schemaname = 'public' and tablename = 'conversations'
         and policyname = 'Members can view their conversations'
         and qual like '%is_conversation_participant%')
     or (schemaname = 'public' and tablename = 'conversation_participants'
         and policyname = 'Members can view fellow participants'
         and qual like '%is_conversation_participant%')
     or (schemaname = 'public' and tablename = 'messages'
         and policyname = 'Members can read messages in their conversations'
         and qual like '%is_conversation_participant%')
     or (schemaname = 'public' and tablename = 'messages'
         and policyname = 'Members can send messages in their conversations'
         and with_check like '%is_conversation_participant%')
     or (schemaname = 'public' and tablename = 'messages'
         and policyname = 'Senders can edit or delete their own messages'
         and qual like '%is_conversation_participant%'
         and with_check like '%is_conversation_participant%');
  if policy_count <> 5 then
    raise exception 'expected all five core conversation/message policies to use helper; got %', policy_count;
  end if;

  select count(*) into policy_count from pg_policies
  where schemaname = 'public' and tablename = 'message_reactions'
    and policyname in (
      'Participants can read reactions in their conversations',
      'Participants can add their own reaction',
      'Users can change their own reaction'
    )
    and (coalesce(qual, '') || coalesce(with_check, '')) like '%is_conversation_participant%';
  if policy_count <> 3 then
    raise exception 'expected reaction read/insert/update policies to use helper; got %', policy_count;
  end if;
end $$;

-- Manual integration checks with separate JWTs:
-- 1. A member can list conversations, participants, messages, and reactions.
-- 2. A nonmember cannot read any of those rows or create messages/reactions.
-- 3. A member cannot alter a message's sender or conversation_id.
-- 4. Block enforcement remains active on message insertion.
