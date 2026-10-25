-- ZannyChat 1.2.232: prevent abandoned accepted calls from blocking users forever.
-- An accepted call is considered live only while a participant renews its lease.
alter table public.call_sessions
  add column if not exists last_activity_at timestamptz not null default now();

create or replace function public.heartbeat_call_session(p_call_id uuid)
returns timestamptz
language plpgsql
security definer
set search_path = ''
as $$
declare
  actor uuid := auth.uid();
  refreshed_at timestamptz;
begin
  if actor is null then
    raise exception 'authentication required' using errcode = '42501';
  end if;
  update public.call_sessions
    set last_activity_at = now()
    where id = p_call_id
      and actor in (caller_id, callee_id)
      and status = 'accepted'
      and last_activity_at > now() - interval '3 minutes'
    returning last_activity_at into refreshed_at;
  if refreshed_at is null then
    raise exception 'call session expired or participant unauthorized' using errcode = '42501';
  end if;
  return refreshed_at;
end;
$$;
revoke all on function public.heartbeat_call_session(uuid) from public, anon;
grant execute on function public.heartbeat_call_session(uuid) to authenticated;

-- Rebuild the session trigger with lease-aware active-call detection.
create or replace function public.validate_call_session_write()
returns trigger language plpgsql security definer set search_path = '' as $$
declare
  actor uuid := auth.uid();
  member_count integer;
  total_count integer;
begin
  if tg_op = 'INSERT' then
    if actor is null or new.caller_id <> actor or new.status <> 'ringing' then
      raise exception 'invalid call creator or initial state' using errcode = '42501';
    end if;
    perform pg_advisory_xact_lock(hashtextextended(least(new.caller_id::text, new.callee_id::text), 0));
    perform pg_advisory_xact_lock(hashtextextended(greatest(new.caller_id::text, new.callee_id::text), 0));
    if exists (
      select 1 from public.call_sessions c
      where ((c.status = 'accepted' and c.last_activity_at > now() - interval '3 minutes')
         or (c.status = 'ringing' and c.expires_at > now()))
      and (c.caller_id in (new.caller_id, new.callee_id) or c.callee_id in (new.caller_id, new.callee_id))
    ) then
      raise exception 'a participant is already in an active call' using errcode = '23505';
    end if;
    select count(*) into member_count from public.conversation_participants cp
      where cp.conversation_id = new.conversation_id and cp.user_id in (new.caller_id, new.callee_id);
    select count(*) into total_count from public.conversation_participants cp where cp.conversation_id = new.conversation_id;
    if member_count <> 2 or total_count <> 2 then
      raise exception 'calls are supported only between the two members of a direct conversation' using errcode = '42501';
    end if;
    if exists (select 1 from public.blocked_users b
      where (b.blocker_id = new.caller_id and b.blocked_id = new.callee_id)
         or (b.blocker_id = new.callee_id and b.blocked_id = new.caller_id)) then
      raise exception 'calls are unavailable for this contact' using errcode = '42501';
    end if;
    new.last_activity_at := now();
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
    if new.last_activity_at is distinct from old.last_activity_at and
       (old.status <> 'accepted' or new.last_activity_at < old.last_activity_at or new.last_activity_at > now() + interval '10 seconds') then
      raise exception 'invalid call heartbeat lease' using errcode = '42501';
    end if;
    return new;
  end if;
  if old.status = 'ringing' and new.status in ('accepted','declined') and actor = old.callee_id then
    if now() > old.expires_at then
      new.status := 'missed'; new.accepted_at := old.accepted_at; new.ended_at := now();
    elsif new.status = 'accepted' then
      new.accepted_at := now(); new.ended_at := old.ended_at; new.last_activity_at := now();
    else
      new.accepted_at := old.accepted_at; new.ended_at := now();
    end if;
  elsif old.status = 'ringing' and new.status = 'cancelled' and actor = old.caller_id then
    new.accepted_at := old.accepted_at; new.ended_at := now();
  elsif old.status = 'accepted' and new.status = 'ended' and actor in (old.caller_id, old.callee_id) then
    new.accepted_at := old.accepted_at; new.ended_at := now();
  else
    raise exception 'invalid call state transition' using errcode = '42501';
  end if;
  return new;
end;
$$;

-- Signals for stale accepted calls are rejected; new calls no longer get blocked by them.
create or replace function public.validate_call_signal_insert()
returns trigger language plpgsql security definer set search_path = '' as $$
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
     or (c.status = 'accepted' and (now() > coalesce(c.accepted_at, c.created_at) + interval '8 hours' or c.last_activity_at < now() - interval '3 minutes')) then
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
  perform pg_advisory_xact_lock(hashtextextended(new.call_id::text || ':' || new.sender_id::text, 0));
  select count(*) into recent_count from public.call_signals
    where call_id = new.call_id and sender_id = new.sender_id and created_at > now() - interval '1 minute';
  if recent_count >= 120 then raise exception 'call signaling rate exceeded' using errcode = '54000'; end if;
  return new;
end;
$$;

comment on column public.call_sessions.last_activity_at is 'Lease renewed by authenticated call participants; calls without a heartbeat for 3 minutes are stale';

-- Retain signaling only while a call is live; keep the cleanup callable by service_role
-- and schedule it automatically only when Supabase's pg_cron extension is available.
create or replace function public.cleanup_stale_call_signals()
returns bigint
language plpgsql
security definer
set search_path = ''
as $$
declare
  deleted_count bigint;
begin
  delete from public.call_signals s
  using public.call_sessions c
  where s.call_id = c.id
    and (
      c.status in ('declined','cancelled','ended','missed','failed')
      or (c.status = 'ringing' and c.expires_at < now())
      or (c.status = 'accepted' and c.last_activity_at < now() - interval '3 minutes')
      or s.created_at < now() - interval '1 day'
    );
  get diagnostics deleted_count = row_count;
  delete from public.call_sessions
    where (status in ('declined','cancelled','ended','missed','failed') and ended_at < now() - interval '30 days')
       or (status = 'ringing' and expires_at < now() - interval '30 days')
       or (status = 'accepted' and last_activity_at < now() - interval '30 days');
  return deleted_count;
end;
$$;
revoke all on function public.cleanup_stale_call_signals() from public, anon, authenticated;
grant execute on function public.cleanup_stale_call_signals() to service_role;

do $$
begin
  if exists (select 1 from pg_extension where extname = 'pg_cron') then
    begin
      execute $schedule$select cron.schedule('zannychat-call-signal-retention', '* * * * *', 'select public.cleanup_stale_call_signals();')$schedule$;
    exception when others then
      raise notice 'Could not schedule call signal cleanup automatically; schedule public.cleanup_stale_call_signals() with the deployment scheduler.';
    end;
  else
    raise notice 'pg_cron is not installed; schedule public.cleanup_stale_call_signals() with the deployment scheduler.';
  end if;
end;
$$;
