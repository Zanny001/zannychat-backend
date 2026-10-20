-- Scheduled message queue. Client roles cannot mutate this table directly;
-- authenticated operations go through the backend after membership checks.
create table if not exists public.scheduled_messages (
  id uuid primary key default gen_random_uuid(),
  conversation_id uuid not null references public.conversations(id) on delete cascade,
  sender_id uuid not null references public.profiles(id) on delete cascade,
  text text not null check (char_length(text) between 1 and 4000),
  scheduled_for timestamptz not null,
  status text not null default 'pending' check (status in ('pending', 'sent', 'cancelled')),
  sent_message_id uuid references public.messages(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  sent_at timestamptz
);
create index if not exists scheduled_messages_due_idx
  on public.scheduled_messages (scheduled_for, created_at)
  where status = 'pending';
create index if not exists scheduled_messages_sender_pending_idx
  on public.scheduled_messages (sender_id, scheduled_for)
  where status = 'pending';
alter table public.scheduled_messages enable row level security;
revoke all on public.scheduled_messages from anon, authenticated;
grant select, insert, update, delete on public.scheduled_messages to service_role;

-- Atomic worker operation: row locks prevent duplicate delivery across concurrent workers.
create or replace function public.deliver_due_scheduled_messages(p_limit integer default 100)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  item public.scheduled_messages%rowtype;
  new_message_id uuid;
  delivered integer := 0;
begin
  if p_limit is null or p_limit < 1 or p_limit > 500 then
    raise exception 'p_limit must be between 1 and 500';
  end if;

  for item in
    select * from public.scheduled_messages
    where status = 'pending' and scheduled_for <= now()
    order by scheduled_for, created_at
    for update skip locked
    limit p_limit
  loop
    -- A user may have been removed from a group after scheduling. Never deliver
    -- on behalf of a sender who is no longer a participant.
    if exists (
      select 1 from public.conversation_participants cp
      where cp.conversation_id = item.conversation_id and cp.user_id = item.sender_id
    ) then
      insert into public.messages (conversation_id, sender_id, text)
      values (item.conversation_id, item.sender_id, item.text)
      returning id into new_message_id;

      update public.scheduled_messages
      set status = 'sent', sent_message_id = new_message_id,
          sent_at = now(), updated_at = now()
      where id = item.id;
      delivered := delivered + 1;
    else
      update public.scheduled_messages
      set status = 'cancelled', updated_at = now()
      where id = item.id;
    end if;
  end loop;
  return delivered;
end;
$$;
revoke all on function public.deliver_due_scheduled_messages(integer) from public, anon, authenticated;
grant execute on function public.deliver_due_scheduled_messages(integer) to service_role;
