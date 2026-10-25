-- ZannyChat 1.2.230: authenticated 1:1 WebRTC call signaling.
-- Media flows peer-to-peer where possible; this schema carries only SDP/ICE
-- signaling metadata, never audio/video payloads. Apply after migrations 0001-0058.

create table if not exists public.call_sessions (
  id uuid primary key default gen_random_uuid(),
  conversation_id uuid not null references public.conversations(id) on delete cascade,
  caller_id uuid not null references auth.users(id) on delete cascade,
  callee_id uuid not null references auth.users(id) on delete cascade,
  call_type text not null check (call_type in ('audio', 'video')),
  status text not null default 'ringing' check (status in ('ringing','accepted','declined','cancelled','ended','missed','failed')),
  created_at timestamptz not null default now(),
  accepted_at timestamptz,
  ended_at timestamptz,
  expires_at timestamptz not null default (now() + interval '60 seconds'),
  constraint call_distinct_participants check (caller_id <> callee_id),
  constraint call_end_after_start check (ended_at is null or ended_at >= created_at)
);

create index if not exists call_sessions_callee_pending_idx
  on public.call_sessions(callee_id, created_at desc) where status = 'ringing';
create index if not exists call_sessions_caller_recent_idx
  on public.call_sessions(caller_id, created_at desc);

alter table public.call_sessions enable row level security;

create or replace function public.validate_call_session_write()
returns trigger language plpgsql security definer set search_path = public as $$
declare
  actor uuid := auth.uid();
  member_count integer;
  total_count integer;
begin
  if tg_op = 'INSERT' then
    if actor is null or new.caller_id <> actor or new.status <> 'ringing' then
      raise exception 'invalid call creator or initial state' using errcode = '42501';
    end if;
    -- Lock both user IDs in deterministic order so concurrent attempts cannot
    -- place the same person in multiple active calls.
    perform pg_advisory_xact_lock(hashtextextended(least(new.caller_id::text, new.callee_id::text), 0));
    perform pg_advisory_xact_lock(hashtextextended(greatest(new.caller_id::text, new.callee_id::text), 0));
    if exists (
      select 1 from public.call_sessions c
      where (c.status = 'accepted' or (c.status = 'ringing' and c.expires_at > now()))
        and (c.caller_id in (new.caller_id, new.callee_id) or c.callee_id in (new.caller_id, new.callee_id))
    ) then
      raise exception 'a participant is already in an active call' using errcode = '23505';
    end if;
    select count(*) into member_count
      from public.conversation_participants cp
      where cp.conversation_id = new.conversation_id
        and cp.user_id in (new.caller_id, new.callee_id);
    select count(*) into total_count from public.conversation_participants cp where cp.conversation_id = new.conversation_id;
    if member_count <> 2 or total_count <> 2 then
      raise exception 'calls are supported only between the two members of a direct conversation' using errcode = '42501';
    end if;
    if exists (
      select 1 from public.blocked_users b
      where (b.blocker_id = new.caller_id and b.blocked_id = new.callee_id)
         or (b.blocker_id = new.callee_id and b.blocked_id = new.caller_id)
    ) then
      raise exception 'calls are unavailable for this contact' using errcode = '42501';
    end if;
    return new;
  end if;

  if new.id <> old.id or new.conversation_id <> old.conversation_id
     or new.caller_id <> old.caller_id or new.callee_id <> old.callee_id
     or new.call_type <> old.call_type or new.created_at <> old.created_at
     or new.expires_at <> old.expires_at then
    raise exception 'call identity fields are immutable' using errcode = '42501';
  end if;
  if actor is null or actor not in (old.caller_id, old.callee_id) then
    raise exception 'not a call participant' using errcode = '42501';
  end if;
  if new.status = old.status then
    if new.accepted_at is distinct from old.accepted_at or new.ended_at is distinct from old.ended_at then
      raise exception 'call lifecycle timestamps are immutable outside a state transition' using errcode = '42501';
    end if;
    return new;
  end if;

  if old.status = 'ringing' and new.status in ('accepted','declined') and actor = old.callee_id then
    if now() > old.expires_at then
      new.status := 'missed';
      new.accepted_at := old.accepted_at;
      new.ended_at := now();
    elsif new.status = 'accepted' then
      new.accepted_at := now();
      new.ended_at := old.ended_at;
    else
      new.accepted_at := old.accepted_at;
      new.ended_at := now();
    end if;
  elsif old.status = 'ringing' and new.status = 'cancelled' and actor = old.caller_id then
    new.accepted_at := old.accepted_at;
    new.ended_at := now();
  elsif old.status = 'accepted' and new.status = 'ended' and actor in (old.caller_id, old.callee_id) then
    new.accepted_at := old.accepted_at;
    new.ended_at := now();
  else
    raise exception 'invalid call state transition' using errcode = '42501';
  end if;
  return new;
end;
$$;

drop trigger if exists validate_call_session_write on public.call_sessions;
create trigger validate_call_session_write
  before insert or update on public.call_sessions
  for each row execute function public.validate_call_session_write();

create policy "Call participants can read their calls"
  on public.call_sessions for select to authenticated
  using (auth.uid() in (caller_id, callee_id));
create policy "Conversation members can initiate direct calls"
  on public.call_sessions for insert to authenticated
  with check (caller_id = auth.uid()); -- SECURITY DEFINER trigger validates both direct-chat members and block state.
create policy "Participants can transition their call state"
  on public.call_sessions for update to authenticated
  using (auth.uid() in (caller_id, callee_id))
  with check (auth.uid() in (caller_id, callee_id));

create table if not exists public.call_signals (
  id bigint generated always as identity primary key,
  call_id uuid not null references public.call_sessions(id) on delete cascade,
  sender_id uuid not null references auth.users(id) on delete cascade,
  recipient_id uuid not null references auth.users(id) on delete cascade,
  signal_type text not null check (signal_type in ('offer','answer','ice-candidate')),
  payload jsonb not null,
  created_at timestamptz not null default now(),
  constraint call_signal_distinct_users check (sender_id <> recipient_id),
  constraint call_signal_payload_size check (octet_length(payload::text) <= 16384)
);
create index if not exists call_signals_call_created_idx on public.call_signals(call_id, created_at);
alter table public.call_signals enable row level security;

create or replace function public.validate_call_signal_insert()
returns trigger language plpgsql security definer set search_path = public as $$
declare
  c public.call_sessions%rowtype;
  recent_count integer;
begin
  if auth.uid() is null or new.sender_id <> auth.uid() then
    raise exception 'invalid signal sender' using errcode = '42501';
  end if;
  select * into c from public.call_sessions where id = new.call_id;
  if not found or c.status not in ('ringing','accepted')
     or (c.status = 'ringing' and now() > c.expires_at)
     or (c.status = 'accepted' and now() > coalesce(c.accepted_at, c.created_at) + interval '8 hours') then
    raise exception 'call is not available for signaling' using errcode = '42501';
  end if;
  if not ((new.sender_id = c.caller_id and new.recipient_id = c.callee_id)
       or (new.sender_id = c.callee_id and new.recipient_id = c.caller_id)) then
    raise exception 'signal recipient is not the other participant' using errcode = '42501';
  end if;
  if new.signal_type = 'offer' and new.sender_id <> c.caller_id then
    raise exception 'only caller can send an offer' using errcode = '42501';
  end if;
  if new.signal_type = 'answer' and (new.sender_id <> c.callee_id or c.status <> 'accepted') then
    raise exception 'only the accepted callee can send an answer' using errcode = '42501';
  end if;
  -- Serialize quota checks for each sender/call so concurrent inserts cannot race past the cap.
  perform pg_advisory_xact_lock(hashtextextended(new.call_id::text || ':' || new.sender_id::text, 0));
  select count(*) into recent_count from public.call_signals
    where call_id = new.call_id and sender_id = new.sender_id and created_at > now() - interval '1 minute';
  if recent_count >= 120 then
    raise exception 'call signaling rate exceeded' using errcode = '54000';
  end if;
  return new;
end;
$$;
drop trigger if exists validate_call_signal_insert on public.call_signals;
create trigger validate_call_signal_insert before insert on public.call_signals
  for each row execute function public.validate_call_signal_insert();

create policy "Call participants can read signaling addressed to them"
  on public.call_signals for select to authenticated
  using (
    auth.uid() in (sender_id, recipient_id)
    and exists (select 1 from public.call_sessions c where c.id = call_id and auth.uid() in (c.caller_id, c.callee_id))
  );
create policy "Participants can send signaling to the other participant"
  on public.call_signals for insert to authenticated
  with check (
    sender_id = auth.uid()
    and exists (select 1 from public.call_sessions c where c.id = call_id and ((c.caller_id = auth.uid() and c.callee_id = recipient_id) or (c.callee_id = auth.uid() and c.caller_id = recipient_id)))
  );

-- Realtime is required for incoming call notifications and SDP/ICE exchange.
do $$ begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    begin alter publication supabase_realtime add table public.call_sessions; exception when duplicate_object then null; end;
    begin alter publication supabase_realtime add table public.call_signals; exception when duplicate_object then null; end;
  end if;
end $$;

comment on table public.call_sessions is '1:1 audio/video call lifecycle; signaling only, no media payloads';
comment on table public.call_signals is 'Short-lived WebRTC SDP/ICE signaling; rows cascade-delete with call session';


-- Remove SDP/ICE payloads immediately when a call reaches a terminal state.
create or replace function public.cleanup_terminal_call_signals()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if new.status in ('declined','cancelled','ended','missed','failed') and old.status is distinct from new.status then
    delete from public.call_signals where call_id = new.id;
  end if;
  return new;
end;
$$;
drop trigger if exists cleanup_terminal_call_signals on public.call_sessions;
create trigger cleanup_terminal_call_signals after update of status on public.call_sessions
  for each row execute function public.cleanup_terminal_call_signals();
