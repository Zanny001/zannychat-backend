-- Shared conversation pins. The row stores a bounded display snapshot so a pin remains
-- useful in the pinned list even when the message is no longer in the loaded page.
create table if not exists public.pinned_messages (
  conversation_id uuid not null references public.conversations(id) on delete cascade,
  message_id uuid not null references public.messages(id) on delete cascade,
  pinned_by uuid not null references auth.users(id) on delete cascade,
  pinned_at timestamptz not null default now(),
  message_text text not null default '',
  sender_name text not null default '',
  message_created_at timestamptz,
  conversation_name text not null default 'Conversation',
  is_group boolean not null default false,
  attachment_type text,
  attachment_name text,
  primary key (conversation_id, message_id),
  constraint pinned_message_text_length check (char_length(message_text) <= 20000),
  constraint pinned_sender_name_length check (char_length(sender_name) <= 120),
  constraint pinned_conversation_name_length check (char_length(conversation_name) <= 160),
  constraint pinned_attachment_name_length check (attachment_name is null or char_length(attachment_name) <= 180)
);

alter table public.pinned_messages enable row level security;
revoke all on public.pinned_messages from anon, authenticated;
grant select, insert, delete on public.pinned_messages to authenticated;

drop policy if exists "Conversation members read shared pins" on public.pinned_messages;
create policy "Conversation members read shared pins" on public.pinned_messages
  for select to authenticated using (
    exists (select 1 from public.conversation_participants cp
      where cp.conversation_id = pinned_messages.conversation_id and cp.user_id = auth.uid())
  );

drop policy if exists "Conversation members pin messages" on public.pinned_messages;
create policy "Conversation members pin messages" on public.pinned_messages
  for insert to authenticated with check (
    pinned_by = auth.uid()
    and exists (select 1 from public.conversation_participants cp
      where cp.conversation_id = pinned_messages.conversation_id and cp.user_id = auth.uid())
    and exists (select 1 from public.messages m
      where m.id = pinned_messages.message_id and m.conversation_id = pinned_messages.conversation_id)
  );

drop policy if exists "Pinner or group admin removes shared pin" on public.pinned_messages;
create policy "Pinner or group admin removes shared pin" on public.pinned_messages
  for delete to authenticated using (
    pinned_by = auth.uid()
    or exists (select 1 from public.conversation_participants cp
      where cp.conversation_id = pinned_messages.conversation_id
        and cp.user_id = auth.uid() and cp.is_admin = true)
  );

-- Do not trust a client-supplied text snapshot: derive it from the authorized source message.
create or replace function public.set_pinned_message_snapshot()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  source_message public.messages%rowtype;
begin
  select * into source_message from public.messages
    where id = new.message_id and conversation_id = new.conversation_id;
  if not found then
    raise exception 'Message does not belong to this conversation';
  end if;
  new.message_text := left(coalesce(source_message.text, ''), 20000);
  new.message_created_at := source_message.created_at;
  return new;
end;
$$;
revoke all on function public.set_pinned_message_snapshot() from public, anon, authenticated;
drop trigger if exists pinned_message_snapshot_before_insert on public.pinned_messages;
create trigger pinned_message_snapshot_before_insert
before insert on public.pinned_messages
for each row execute function public.set_pinned_message_snapshot();
