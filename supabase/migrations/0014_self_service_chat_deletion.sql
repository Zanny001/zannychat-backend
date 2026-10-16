-- Allow a signed-in user to remove only their own membership row from a chat.
-- This powers per-user "Delete chat" without granting the ability to remove
-- other participants or directly delete conversation/message records.
-- Safe to re-run.
-- This is a per-user hide/leave operation, not a global conversation purge.
-- Messages and the conversation row are retained; other participants keep history.

grant delete on table public.conversation_participants to authenticated;

drop policy if exists "Users can leave or hide their own conversations"
  on public.conversation_participants;
create policy "Users can leave or hide their own conversations"
  on public.conversation_participants
  for delete
  to authenticated
  using (user_id = (select auth.uid()));

-- Deliberately do not grant DELETE on conversations or messages here.
-- No empty-direct-conversation cleanup trigger is defined in this migration set.
-- The row is hidden from the user who leaves; the conversation and messages are
-- retained for other participants and for controlled administrative retention.
