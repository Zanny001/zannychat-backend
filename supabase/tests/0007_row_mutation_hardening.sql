-- Database-side verification for migration 0007.
-- Run as a database owner after migrations 0001-0007, for example with:
--   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f supabase/tests/0007_row_mutation_hardening.sql
-- This script checks ACLs and installed policies/triggers without modifying data.

do $$
begin
  -- Participant identity must be immutable to authenticated clients.
  if has_column_privilege('authenticated', 'public.conversation_participants', 'conversation_id', 'UPDATE') then
    raise exception 'authenticated unexpectedly has UPDATE on conversation_participants.conversation_id';
  end if;
  if has_column_privilege('authenticated', 'public.conversation_participants', 'user_id', 'UPDATE') then
    raise exception 'authenticated unexpectedly has UPDATE on conversation_participants.user_id';
  end if;
  if not has_column_privilege('authenticated', 'public.conversation_participants', 'last_read_at', 'UPDATE') then
    raise exception 'authenticated is missing UPDATE on conversation_participants.last_read_at';
  end if;
  if not has_column_privilege('authenticated', 'public.conversation_participants', 'is_muted', 'UPDATE') then
    raise exception 'authenticated is missing UPDATE on conversation_participants.is_muted';
  end if;

  -- Message content/state can change, but authorship and routing cannot.
  if has_column_privilege('authenticated', 'public.messages', 'conversation_id', 'UPDATE') then
    raise exception 'authenticated unexpectedly has UPDATE on messages.conversation_id';
  end if;
  if has_column_privilege('authenticated', 'public.messages', 'sender_id', 'UPDATE') then
    raise exception 'authenticated unexpectedly has UPDATE on messages.sender_id';
  end if;
  if not has_column_privilege('authenticated', 'public.messages', 'text', 'UPDATE') then
    raise exception 'authenticated is missing UPDATE on messages.text';
  end if;
  if not has_column_privilege('authenticated', 'public.messages', 'deleted_at', 'UPDATE') then
    raise exception 'authenticated is missing UPDATE on messages.deleted_at';
  end if;

  -- Reaction upsert must be able to replace emoji while identity fields
  -- are guarded by a trigger. This mirrors the frontend's actual payload.
  if not has_column_privilege('authenticated', 'public.message_reactions', 'emoji', 'UPDATE') then
    raise exception 'authenticated is missing UPDATE on message_reactions.emoji';
  end if;
  if not has_column_privilege('authenticated', 'public.message_reactions', 'message_id', 'UPDATE') then
    raise exception 'authenticated is missing UPDATE on message_reactions.message_id required by upsert';
  end if;
  if not has_column_privilege('authenticated', 'public.message_reactions', 'user_id', 'UPDATE') then
    raise exception 'authenticated is missing UPDATE on message_reactions.user_id required by upsert';
  end if;
  if has_column_privilege('authenticated', 'public.message_reactions', 'id', 'UPDATE') then
    raise exception 'authenticated unexpectedly has UPDATE on message_reactions.id';
  end if;
  if has_column_privilege('authenticated', 'public.message_reactions', 'created_at', 'UPDATE') then
    raise exception 'authenticated unexpectedly has UPDATE on message_reactions.created_at';
  end if;

  if not exists (
    select 1 from pg_policies
    where schemaname = 'public' and tablename = 'messages'
      and policyname = 'Senders can edit or delete their own messages'
  ) then
    raise exception 'hardened message update policy is missing';
  end if;
  if not exists (
    select 1 from pg_policies
    where schemaname = 'public' and tablename = 'message_reactions'
      and policyname = 'Users can change their own reaction'
  ) then
    raise exception 'hardened reaction update policy is missing';
  end if;
  if not exists (
    select 1 from pg_trigger
    where tgrelid = 'public.message_reactions'::regclass
      and tgname = 'prevent_reaction_identity_change'
      and not tgisinternal and tgenabled <> 'D'
  ) then
    raise exception 'reaction identity guard trigger is missing or disabled';
  end if;
end;
$$;

select '0007 row-mutation hardening checks passed' as result;
