-- Replace direct RLS subqueries against conversation_participants with a
-- SECURITY DEFINER membership helper. The original participant SELECT policy
-- queried conversation_participants again, which can cause infinite RLS policy
-- recursion in conversation, message, reaction, and Storage operations.
-- Keep this helper in the non-PostgREST private schema and expose only the
-- current caller's membership boolean for a conversation ID.
create schema if not exists private;
revoke all on schema private from public, anon;
grant usage on schema private to authenticated;

create or replace function private.is_conversation_participant(p_conversation_id uuid)
returns boolean
language sql
stable
security definer
set search_path = pg_catalog
as $$
  select auth.uid() is not null
    and exists (
      select 1
      from public.conversation_participants cp
      where cp.conversation_id = p_conversation_id
        and cp.user_id = auth.uid()
    );
$$;

revoke all on function private.is_conversation_participant(uuid) from public, anon, authenticated;
grant execute on function private.is_conversation_participant(uuid) to authenticated;

-- Keep the block guard's search path pinned as well. It still reveals only a
-- boolean and only for the authenticated caller's own sender identity and a
-- conversation they participate in.
create or replace function public.is_blocked_in_conversation(p_conversation_id uuid, p_sender_id uuid)
returns boolean
language sql
stable
security definer
set search_path = pg_catalog
as $$
  select p_sender_id = auth.uid()
    and private.is_conversation_participant(p_conversation_id)
    and exists (
      select 1
      from public.conversation_participants cp
      join public.blocked_users b
        on b.blocker_id = cp.user_id
       and b.blocked_id = p_sender_id
      where cp.conversation_id = p_conversation_id
        and cp.user_id <> p_sender_id
    );
$$;
revoke all on function public.is_blocked_in_conversation(uuid, uuid) from public, anon, authenticated;
grant execute on function public.is_blocked_in_conversation(uuid, uuid) to authenticated;

-- Conversation and participant visibility.
drop policy if exists "Members can view their conversations" on public.conversations;
create policy "Members can view their conversations"
  on public.conversations for select to authenticated
  using (private.is_conversation_participant(id));

drop policy if exists "Members can view fellow participants" on public.conversation_participants;
create policy "Members can view fellow participants"
  on public.conversation_participants for select to authenticated
  using (private.is_conversation_participant(conversation_id));

-- Message reads and writes. Keep the existing block check on message inserts.
drop policy if exists "Members can read messages in their conversations" on public.messages;
create policy "Members can read messages in their conversations"
  on public.messages for select to authenticated
  using (private.is_conversation_participant(conversation_id));

drop policy if exists "Members can send messages in their conversations" on public.messages;
create policy "Members can send messages in their conversations"
  on public.messages for insert to authenticated
  with check (
    sender_id = auth.uid()
    and private.is_conversation_participant(conversation_id)
    and not public.is_blocked_in_conversation(conversation_id, auth.uid())
  );

drop policy if exists "Senders can edit or delete their own messages" on public.messages;
create policy "Senders can edit or delete their own messages"
  on public.messages for update to authenticated
  using (sender_id = auth.uid() and private.is_conversation_participant(conversation_id))
  with check (sender_id = auth.uid() and private.is_conversation_participant(conversation_id));

-- Reaction policies may inspect messages (whose SELECT policy now uses the
-- helper) but never query conversation_participants directly.
drop policy if exists "Participants can read reactions in their conversations" on public.message_reactions;
create policy "Participants can read reactions in their conversations"
  on public.message_reactions for select to authenticated
  using (
    exists (
      select 1 from public.messages m
      where m.id = message_reactions.message_id
        and private.is_conversation_participant(m.conversation_id)
    )
  );

drop policy if exists "Participants can add their own reaction" on public.message_reactions;
create policy "Participants can add their own reaction"
  on public.message_reactions for insert to authenticated
  with check (
    user_id = auth.uid()
    and exists (
      select 1 from public.messages m
      where m.id = message_reactions.message_id
        and private.is_conversation_participant(m.conversation_id)
    )
  );

drop policy if exists "Users can change their own reaction" on public.message_reactions;
create policy "Users can change their own reaction"
  on public.message_reactions for update to authenticated
  using (
    user_id = auth.uid()
    and exists (
      select 1 from public.messages m
      where m.id = message_reactions.message_id
        and private.is_conversation_participant(m.conversation_id)
    )
  )
  with check (
    user_id = auth.uid()
    and exists (
      select 1 from public.messages m
      where m.id = message_reactions.message_id
        and private.is_conversation_participant(m.conversation_id)
    )
  );

-- Ensure these internal helpers are not exposed as public PostgREST RPCs.
-- The project API exposed-schema configuration must exclude the private schema.
