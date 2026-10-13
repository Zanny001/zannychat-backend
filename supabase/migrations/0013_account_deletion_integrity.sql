-- Account deletion integrity. A message may reply to a message authored by
-- an account being deleted. Without SET NULL, the FK can prevent cascading
-- deletion of that account's messages. Keep the reply itself but remove the
-- now-missing target, so clients render it as an unavailable parent.

alter table public.messages
  drop constraint if exists messages_reply_to_id_fkey;

alter table public.messages
  add constraint messages_reply_to_id_fkey
  foreign key (reply_to_id) references public.messages(id) on delete set null;


-- When deleting a user removes one side of a direct conversation, remove the
-- now-orphaned direct conversation and its messages in the same transaction.
-- Group conversations are deliberately retained for the remaining members.
create or replace function public.cleanup_empty_direct_conversation()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  delete from public.conversations c
  where c.id = old.conversation_id
    and coalesce(c.is_group, false) = false
    and (select count(*) from public.conversation_participants cp
         where cp.conversation_id = old.conversation_id) < 2;
  return old;
end;
$$;

drop trigger if exists cleanup_empty_direct_conversation_after_member_delete
  on public.conversation_participants;
create trigger cleanup_empty_direct_conversation_after_member_delete
after delete on public.conversation_participants
for each row execute function public.cleanup_empty_direct_conversation();

revoke all on function public.cleanup_empty_direct_conversation() from public, anon, authenticated;
