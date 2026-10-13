-- ZannyChat — close row-mutation paths in participant, message, and reaction updates.
-- Run after 0001-0006. Safe to re-run: grants/revokes are repeatable and
-- policies/triggers are dropped before being recreated.
--
-- Critical: the old participant UPDATE policy only checked user_id = auth.uid().
-- Without column privileges, a user could change conversation_id on their own
-- row and effectively join another conversation. Message updates similarly
-- must not be able to move a message between conversations or change authorship.

-- A participant may update only their own state fields, never membership identity.
revoke update on table public.conversation_participants from PUBLIC, anon, authenticated;
revoke update (
  conversation_id, user_id, joined_at, last_read_at, is_favorite, is_muted, is_archived
) on table public.conversation_participants from PUBLIC, anon, authenticated;
grant update (last_read_at, is_favorite, is_muted, is_archived)
  on table public.conversation_participants to authenticated;

-- Editing/deleting a message must not let a sender rewrite its identity,
-- timestamp, reply target, or conversation membership.
revoke update on table public.messages from PUBLIC, anon, authenticated;
revoke update (
  id, conversation_id, sender_id, text, reply_to_id, created_at, edited_at, deleted_at
) on table public.messages from PUBLIC, anon, authenticated;
grant update (text, edited_at, deleted_at) on table public.messages to authenticated;

drop policy if exists "Senders can edit or delete their own messages" on public.messages;
create policy "Senders can edit or delete their own messages"
  on public.messages for update
  to authenticated
  using (
    sender_id = auth.uid()
    and exists (
      select 1 from public.conversation_participants cp
      where cp.conversation_id = messages.conversation_id
        and cp.user_id = auth.uid()
    )
  )
  with check (
    sender_id = auth.uid()
    and exists (
      select 1 from public.conversation_participants cp
      where cp.conversation_id = messages.conversation_id
        and cp.user_id = auth.uid()
    )
  );

-- A reaction update is allowed only while the caller participates in the
-- reaction's conversation. Supabase's current frontend uses upsert with
-- (message_id, user_id, emoji); PostgreSQL requires UPDATE privileges on all
-- supplied conflict columns even when identity values stay unchanged. Grant
-- only those three columns, and use the trigger below to make message_id and
-- user_id immutable on UPDATE. id and created_at remain non-updatable.
revoke update on table public.message_reactions from PUBLIC, anon, authenticated;
revoke update (id, message_id, user_id, emoji, created_at)
  on table public.message_reactions from PUBLIC, anon, authenticated;
grant update (message_id, user_id, emoji)
  on table public.message_reactions to authenticated;

drop policy if exists "Users can change their own reaction" on public.message_reactions;
create policy "Users can change their own reaction"
  on public.message_reactions for update
  to authenticated
  using (
    user_id = auth.uid()
    and exists (
      select 1
      from public.messages m
      join public.conversation_participants cp
        on cp.conversation_id = m.conversation_id
       and cp.user_id = auth.uid()
      where m.id = message_reactions.message_id
    )
  )
  with check (
    user_id = auth.uid()
    and exists (
      select 1
      from public.messages m
      join public.conversation_participants cp
        on cp.conversation_id = m.conversation_id
       and cp.user_id = auth.uid()
      where m.id = message_reactions.message_id
    )
  );

create or replace function public.prevent_reaction_identity_change()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  if new.id is distinct from old.id
     or new.message_id is distinct from old.message_id
     or new.user_id is distinct from old.user_id
     or new.created_at is distinct from old.created_at then
    raise exception 'Reaction identity fields cannot be changed'
      using errcode = '42501';
  end if;
  return new;
end;
$$;

drop trigger if exists prevent_reaction_identity_change on public.message_reactions;
create trigger prevent_reaction_identity_change
  before update on public.message_reactions
  for each row execute function public.prevent_reaction_identity_change();
