-- Privacy boundary for presence and read receipts.
-- Additive only: preserves legacy participant columns and does not change existing rows.

alter table public.profile_details
  add column if not exists last_seen_at timestamptz;

create table if not exists public.user_presence_sessions (
  user_id uuid primary key references auth.users(id) on delete cascade,
  last_active_at timestamptz not null default now(),
  is_active boolean not null default true,
  updated_at timestamptz not null default now()
);
create index if not exists user_presence_sessions_active_idx
  on public.user_presence_sessions(is_active, last_active_at desc);
alter table public.user_presence_sessions enable row level security;
revoke all on public.user_presence_sessions from public, anon, authenticated;
grant select, insert, update on public.user_presence_sessions to authenticated;
drop policy if exists "Users manage only their own presence session" on public.user_presence_sessions;
create policy "Users manage only their own presence session"
  on public.user_presence_sessions for all to authenticated
  using (user_id = (select auth.uid()))
  with check (user_id = (select auth.uid()));

-- Client may only heartbeat its own session. Backgrounding marks it inactive;
-- a killed app naturally expires after the 90-second freshness window.
create or replace function public.heartbeat_presence(p_active boolean default true)
returns void
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare v_user uuid := auth.uid();
begin
  if v_user is null then raise exception 'Authentication required' using errcode = '42501'; end if;
  insert into public.user_presence_sessions(user_id, last_active_at, is_active, updated_at)
  values (v_user, now(), coalesce(p_active, true), now())
  on conflict (user_id) do update
    set last_active_at = excluded.last_active_at,
        is_active = excluded.is_active,
        updated_at = excluded.updated_at;
  insert into public.profile_details(user_id, last_seen_at, updated_at)
  values (v_user, now(), now())
  on conflict (user_id) do update set last_seen_at = excluded.last_seen_at, updated_at = excluded.updated_at;
end;
$$;
revoke all on function public.heartbeat_presence(boolean) from public, anon;
grant execute on function public.heartbeat_presence(boolean) to authenticated;

-- Returns presence only for existing conversation contacts, never for blocked
-- relationships. Online and last-seen have independent privacy switches.
create or replace function public.get_visible_presence()
returns table(user_id uuid, is_online boolean, last_seen_at timestamptz)
language sql
stable
security definer
set search_path = pg_catalog, public
as $$
  select p.id,
    (coalesce(d.show_online_status, true) and coalesce(s.is_active, false)
      and s.last_active_at >= now() - interval '90 seconds') as is_online,
    case when coalesce(d.show_last_seen, false) then d.last_seen_at else null end as last_seen_at
  from public.profiles p
  join public.conversation_participants mine on mine.user_id = auth.uid()
  join public.conversation_participants peer on peer.conversation_id = mine.conversation_id and peer.user_id = p.id
  left join public.profile_details d on d.user_id = p.id
  left join public.user_presence_sessions s on s.user_id = p.id
  where auth.uid() is not null
    and p.id <> auth.uid()
    and (coalesce(d.show_online_status, true) or coalesce(d.show_last_seen, false))
    and not exists (
      select 1 from public.blocked_users b
      where (b.blocker_id = auth.uid() and b.blocked_id = p.id)
         or (b.blocker_id = p.id and b.blocked_id = auth.uid())
    )
  group by p.id, d.show_online_status, d.show_last_seen, d.last_seen_at,
           s.is_active, s.last_active_at;
$$;
revoke all on function public.get_visible_presence() from public, anon;
grant execute on function public.get_visible_presence() to authenticated;

-- Dedicated privacy-filtered read cursor projection. Membership remains intact;
-- a member's read timestamp is omitted when that member disabled read receipts.
create or replace function public.get_conversation_read_state(p_conversation_id uuid)
returns table(user_id uuid, last_read_at timestamptz)
language plpgsql
stable
security definer
set search_path = pg_catalog, public
as $$
begin
  if auth.uid() is null or not private.is_conversation_participant(p_conversation_id) then
    raise exception 'Conversation not available' using errcode = '42501';
  end if;
  return query
    select cp.user_id,
      case when cp.user_id = auth.uid() or coalesce(d.show_read_receipts, true)
        then cp.last_read_at else null end
    from public.conversation_participants cp
    left join public.profile_details d on d.user_id = cp.user_id
    where cp.conversation_id = p_conversation_id;
end;
$$;
revoke all on function public.get_conversation_read_state(uuid) from public, anon;
grant execute on function public.get_conversation_read_state(uuid) to authenticated;


-- The current user's own read cursors are separate from fellow participants'
-- read-receipt projection, preserving unread counts without exposing peers.
create or replace function public.get_my_read_cursors()
returns table(conversation_id uuid, last_read_at timestamptz)
language sql
stable
security definer
set search_path = pg_catalog, public
as $$
  select cp.conversation_id, cp.last_read_at
  from public.conversation_participants cp
  where cp.user_id = auth.uid();
$$;
revoke all on function public.get_my_read_cursors() from public, anon;
grant execute on function public.get_my_read_cursors() to authenticated;
