-- Message deletion modes: per-viewer hiding and author-only global retraction.
-- Existing messages and conversation data are preserved.

create table if not exists public.message_hidden_for (
  message_id uuid not null references public.messages(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  hidden_at timestamptz not null default now(),
  primary key (message_id, user_id)
);

alter table public.message_hidden_for enable row level security;
revoke all on public.message_hidden_for from anon, authenticated;
grant select on public.message_hidden_for to authenticated;
create policy "Users can read their own message hides"
  on public.message_hidden_for for select to authenticated
  using (user_id = auth.uid());

-- Hide only rows explicitly hidden by the current viewer. Global tombstones
-- remain visible so the conversation timeline does not collapse.
drop policy if exists "Members can read messages in their conversations" on public.messages;
create policy "Members can read visible messages in their conversations"
  on public.messages for select to authenticated
  using (
    exists (
      select 1 from public.conversation_participants cp
      where cp.conversation_id = messages.conversation_id
        and cp.user_id = auth.uid()
    )
    and not exists (
      select 1 from public.message_hidden_for mh
      where mh.message_id = messages.id and mh.user_id = auth.uid()
    )
  );

create or replace function public.delete_message(p_message_id uuid, p_mode text)
returns void
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_user_id uuid := auth.uid();
  v_message public.messages%rowtype;
begin
  if v_user_id is null then
    raise exception 'Authentication required' using errcode = '42501';
  end if;
  if p_mode not in ('me', 'everyone') then
    raise exception 'Invalid deletion mode' using errcode = '22023';
  end if;

  select * into v_message
  from public.messages
  where id = p_message_id
    and exists (
      select 1 from public.conversation_participants cp
      where cp.conversation_id = messages.conversation_id
        and cp.user_id = v_user_id
    )
  for update;

  if not found then
    raise exception 'Message not found' using errcode = 'P0002';
  end if;

  if p_mode = 'me' then
    insert into public.message_hidden_for(message_id, user_id)
    values (p_message_id, v_user_id)
    on conflict (message_id, user_id) do nothing;
    return;
  end if;

  if v_message.sender_id <> v_user_id then
    raise exception 'Only the sender can delete a message for everyone' using errcode = '42501';
  end if;

  -- Keep a tombstone for replies/timeline continuity but remove message
  -- content and attachment references from the row.
  update public.messages
  set deleted_at = coalesce(deleted_at, now()),
      text = '',
      media_url = null,
      media_name = null,
      media_size = null,
      media_duration = null
  where id = p_message_id;
end;
$$;

revoke all on function public.delete_message(uuid, text) from public, anon;
grant execute on function public.delete_message(uuid, text) to authenticated;
