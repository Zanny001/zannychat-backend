-- Group announcement mode: only admins may send messages when enabled.
-- Enforced by message INSERT RLS so direct Supabase writes cannot bypass it.
alter table public.conversations
  add column if not exists admin_only_messages boolean not null default false;

create or replace function private.can_send_conversation_message(p_conversation_id uuid)
returns boolean
language sql
stable
security definer
set search_path = pg_catalog
as $$
  select auth.uid() is not null
    and exists (
      select 1
      from public.conversations c
      join public.conversation_participants cp on cp.conversation_id = c.id
      where c.id = p_conversation_id
        and cp.user_id = auth.uid()
        and (not c.is_group or not c.admin_only_messages or cp.is_admin)
    );
$$;
revoke all on function private.can_send_conversation_message(uuid) from public, anon, authenticated;
grant execute on function private.can_send_conversation_message(uuid) to authenticated;

drop policy if exists "Members can send messages in their conversations" on public.messages;
create policy "Members can send messages in their conversations"
  on public.messages for insert to authenticated
  with check (
    sender_id = auth.uid()
    and private.can_send_conversation_message(conversation_id)
    and not public.is_blocked_in_conversation(conversation_id, auth.uid())
  );
