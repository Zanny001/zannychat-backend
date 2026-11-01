
-- ===== supabase/migrations/0017_polls.sql =====
-- Conversation polls with single-choice voting. Multi-select and events are future work.
create table if not exists public.polls (
  id uuid primary key default gen_random_uuid(),
  conversation_id uuid not null references public.conversations(id) on delete cascade,
  creator_id uuid not null references public.profiles(id) on delete cascade,
  question text not null check (char_length(btrim(question)) between 1 and 240),
  closes_at timestamptz,
  created_at timestamptz not null default now(),
  check (closes_at is null or closes_at > created_at)
);
create table if not exists public.poll_options (
  id uuid primary key default gen_random_uuid(),
  poll_id uuid not null references public.polls(id) on delete cascade,
  label text not null check (char_length(btrim(label)) between 1 and 120),
  position integer not null check (position between 0 and 9),
  unique (poll_id, position), unique (poll_id, label)
);
create table if not exists public.poll_votes (
  poll_id uuid not null references public.polls(id) on delete cascade,
  option_id uuid not null references public.poll_options(id) on delete cascade,
  user_id uuid not null references public.profiles(id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (poll_id, user_id)
);
create index if not exists polls_conversation_created_idx on public.polls(conversation_id, created_at desc);
create index if not exists poll_votes_option_idx on public.poll_votes(option_id);
alter table public.polls enable row level security;
alter table public.poll_options enable row level security;
alter table public.poll_votes enable row level security;

create policy "Conversation members read polls" on public.polls for select to authenticated using (
 exists (select 1 from public.conversation_participants cp where cp.conversation_id = polls.conversation_id and cp.user_id = (select auth.uid()))
);
create policy "Conversation members create polls" on public.polls for insert to authenticated with check (
 creator_id = (select auth.uid()) and exists (select 1 from public.conversation_participants cp where cp.conversation_id = polls.conversation_id and cp.user_id = (select auth.uid()))
);
create policy "Creators delete polls" on public.polls for delete to authenticated using (creator_id = (select auth.uid()));
create policy "Members read poll options" on public.poll_options for select to authenticated using (
 exists (select 1 from public.polls p join public.conversation_participants cp on cp.conversation_id = p.conversation_id where p.id = poll_options.poll_id and cp.user_id = (select auth.uid()))
);
create policy "Poll creators add options" on public.poll_options for insert to authenticated with check (
 exists (select 1 from public.polls p where p.id = poll_options.poll_id and p.creator_id = (select auth.uid()))
);
create policy "Members read poll votes" on public.poll_votes for select to authenticated using (
 exists (select 1 from public.polls p join public.conversation_participants cp on cp.conversation_id = p.conversation_id where p.id = poll_votes.poll_id and cp.user_id = (select auth.uid()))
);
create policy "Members vote once on open polls" on public.poll_votes for insert to authenticated with check (
 user_id = (select auth.uid())
 and exists (select 1 from public.polls p join public.conversation_participants cp on cp.conversation_id = p.conversation_id where p.id = poll_votes.poll_id and cp.user_id = (select auth.uid()) and (p.closes_at is null or p.closes_at > now()))
 and exists (select 1 from public.poll_options o where o.id = poll_votes.option_id and o.poll_id = poll_votes.poll_id)
);
create policy "Voters can change their vote on open polls" on public.poll_votes for update to authenticated using (user_id = (select auth.uid()) and exists (select 1 from public.polls p where p.id = poll_votes.poll_id and (p.closes_at is null or p.closes_at > now()))) with check (user_id = (select auth.uid()));
create policy "Voters can retract their vote" on public.poll_votes for delete to authenticated using (user_id = (select auth.uid()));
revoke all on public.polls, public.poll_options, public.poll_votes from anon;
grant select on public.polls, public.poll_options, public.poll_votes to authenticated;
-- Mutations are intentionally RPC-only so poll creation is atomic and votes are validated.

-- Atomic creation prevents orphan polls when an option insert fails.
create or replace function public.create_conversation_poll(p_conversation_id uuid, p_question text, p_options text[], p_closes_at timestamptz default null)
returns uuid language plpgsql security definer set search_path = public as $$
declare v_poll_id uuid; v_option text; v_position integer := 0; v_question text := btrim(coalesce(p_question, ''));
begin
  if auth.uid() is null then raise exception 'Authentication required'; end if;
  if char_length(v_question) not between 1 and 240 then raise exception 'Question must be 1-240 characters'; end if;
  if p_options is null or cardinality(p_options) not between 2 and 10 then raise exception 'Provide 2-10 options'; end if;
  if p_closes_at is not null and p_closes_at <= now() then raise exception 'Poll closing time must be in the future'; end if;
  if not exists (select 1 from public.conversation_participants cp where cp.conversation_id = p_conversation_id and cp.user_id = auth.uid()) then raise exception 'Conversation membership required'; end if;
  if exists (select 1 from unnest(p_options) x where char_length(btrim(coalesce(x, ''))) not between 1 and 120) then raise exception 'Each option must be 1-120 characters'; end if;
  if (select count(distinct lower(btrim(x))) from unnest(p_options) x) <> cardinality(p_options) then raise exception 'Options must be unique'; end if;
  insert into public.polls(conversation_id, creator_id, question, closes_at) values (p_conversation_id, auth.uid(), v_question, p_closes_at) returning id into v_poll_id;
  foreach v_option in array p_options loop
    insert into public.poll_options(poll_id, label, position) values (v_poll_id, btrim(v_option), v_position);
    v_position := v_position + 1;
  end loop;
  return v_poll_id;
end; $$;
create or replace function public.cast_poll_vote(p_poll_id uuid, p_option_id uuid)
returns void language plpgsql security definer set search_path = public as $$
begin
  if auth.uid() is null then raise exception 'Authentication required'; end if;
  if not exists (select 1 from public.polls p join public.conversation_participants cp on cp.conversation_id = p.conversation_id where p.id = p_poll_id and cp.user_id = auth.uid() and (p.closes_at is null or p.closes_at > now())) then raise exception 'Poll is closed or unavailable'; end if;
  if not exists (select 1 from public.poll_options o where o.id = p_option_id and o.poll_id = p_poll_id) then raise exception 'Invalid option'; end if;
  insert into public.poll_votes(poll_id, option_id, user_id) values (p_poll_id, p_option_id, auth.uid())
  on conflict (poll_id, user_id) do update set option_id = excluded.option_id, created_at = now();
end; $$;
revoke all on function public.create_conversation_poll(uuid, text, text[], timestamptz) from public, anon;
revoke all on function public.cast_poll_vote(uuid, uuid) from public, anon;
grant execute on function public.create_conversation_poll(uuid, text, text[], timestamptz) to authenticated;
grant execute on function public.cast_poll_vote(uuid, uuid) to authenticated;


-- ===== supabase/migrations/0018_conversation_events.sql =====
-- Conversation events with participant-scoped visibility and one RSVP per member.
create table if not exists public.conversation_events (
  id uuid primary key default gen_random_uuid(),
  conversation_id uuid not null references public.conversations(id) on delete cascade,
  creator_id uuid not null references public.profiles(id) on delete cascade,
  title text not null check (char_length(btrim(title)) between 1 and 160),
  description text not null default '' check (char_length(description) <= 1000),
  starts_at timestamptz not null,
  location text not null default '' check (char_length(location) <= 240),
  created_at timestamptz not null default now(),
  check (starts_at > created_at)
);
create table if not exists public.conversation_event_rsvps (
  event_id uuid not null references public.conversation_events(id) on delete cascade,
  user_id uuid not null references public.profiles(id) on delete cascade,
  response text not null check (response in ('going','maybe','not_going')),
  updated_at timestamptz not null default now(),
  primary key (event_id, user_id)
);
create index if not exists conversation_events_start_idx on public.conversation_events(conversation_id, starts_at);
alter table public.conversation_events enable row level security;
alter table public.conversation_event_rsvps enable row level security;
create policy "Conversation members read events" on public.conversation_events for select to authenticated using (
 exists (select 1 from public.conversation_participants cp where cp.conversation_id = conversation_events.conversation_id and cp.user_id = (select auth.uid()))
);
create policy "Conversation members read event RSVPs" on public.conversation_event_rsvps for select to authenticated using (
 exists (select 1 from public.conversation_events e join public.conversation_participants cp on cp.conversation_id = e.conversation_id where e.id = conversation_event_rsvps.event_id and cp.user_id = (select auth.uid()))
);
revoke all on public.conversation_events, public.conversation_event_rsvps from anon;
grant select on public.conversation_events, public.conversation_event_rsvps to authenticated;
create or replace function public.create_conversation_event(p_conversation_id uuid, p_title text, p_starts_at timestamptz, p_description text default '', p_location text default '')
returns uuid language plpgsql security definer set search_path = public as $$
declare v_id uuid; v_title text := btrim(coalesce(p_title,'')); v_description text := coalesce(p_description,''); v_location text := coalesce(p_location,'');
begin
 if auth.uid() is null then raise exception 'Authentication required'; end if;
 if char_length(v_title) not between 1 and 160 then raise exception 'Event title must be 1-160 characters'; end if;
 if char_length(v_description) > 1000 or char_length(v_location) > 240 then raise exception 'Event details are too long'; end if;
 if p_starts_at is null or p_starts_at <= now() then raise exception 'Event time must be in the future'; end if;
 if not exists (select 1 from public.conversation_participants cp where cp.conversation_id=p_conversation_id and cp.user_id=auth.uid()) then raise exception 'Conversation membership required'; end if;
 insert into public.conversation_events(conversation_id,creator_id,title,description,starts_at,location) values(p_conversation_id,auth.uid(),v_title,v_description,v_location,p_starts_at) returning id into v_id;
 return v_id;
end; $$;
create or replace function public.respond_to_conversation_event(p_event_id uuid, p_response text)
returns void language plpgsql security definer set search_path = public as $$
begin
 if auth.uid() is null then raise exception 'Authentication required'; end if;
 if p_response not in ('going','maybe','not_going') then raise exception 'Invalid RSVP response'; end if;
 if not exists (select 1 from public.conversation_events e join public.conversation_participants cp on cp.conversation_id=e.conversation_id where e.id=p_event_id and cp.user_id=auth.uid()) then raise exception 'Event unavailable'; end if;
 insert into public.conversation_event_rsvps(event_id,user_id,response,updated_at) values(p_event_id,auth.uid(),p_response,now()) on conflict(event_id,user_id) do update set response=excluded.response,updated_at=now();
end; $$;
revoke all on function public.create_conversation_event(uuid,text,timestamptz,text,text) from public, anon;
revoke all on function public.respond_to_conversation_event(uuid,text) from public, anon;
grant execute on function public.create_conversation_event(uuid,text,timestamptz,text,text) to authenticated;
grant execute on function public.respond_to_conversation_event(uuid,text) to authenticated;


-- ===== supabase/migrations/0019_group_administration.sql =====
-- Group administration roles. Existing groups receive one initial admin: the
-- earliest joined participant. New groups explicitly mark their creator as admin.
alter table public.conversation_participants
  add column if not exists is_admin boolean not null default false;

with ranked_members as (
  select cp.conversation_id, cp.user_id,
         row_number() over (partition by cp.conversation_id order by cp.joined_at asc, cp.user_id asc) as member_rank
  from public.conversation_participants cp
  join public.conversations c on c.id = cp.conversation_id
  where c.is_group = true
)
update public.conversation_participants cp
set is_admin = true
from ranked_members rm
where rm.conversation_id = cp.conversation_id
  and rm.user_id = cp.user_id
  and rm.member_rank = 1
  and not exists (
    select 1 from public.conversation_participants existing_admin
    where existing_admin.conversation_id = cp.conversation_id and existing_admin.is_admin = true
  );

create index if not exists conversation_participants_group_admin_idx
  on public.conversation_participants (conversation_id, is_admin)
  where is_admin = true;


-- ===== supabase/migrations/0020_group_invites.sql =====
-- Revocable, bounded-use group invites. Plain tokens are never stored: only SHA-256 hashes are persisted.
create table if not exists public.group_invites (
  id uuid primary key default gen_random_uuid(),
  conversation_id uuid not null references public.conversations(id) on delete cascade,
  token_hash text not null unique check (length(token_hash) = 64),
  created_by uuid not null references public.profiles(id) on delete cascade,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null,
  max_uses integer not null default 25 check (max_uses between 1 and 100),
  use_count integer not null default 0 check (use_count >= 0),
  revoked_at timestamptz,
  check (expires_at > created_at)
);
create index if not exists group_invites_active_idx on public.group_invites (conversation_id, expires_at) where revoked_at is null;
alter table public.group_invites enable row level security;
revoke all on public.group_invites from anon, authenticated;
grant select, insert, update, delete on public.group_invites to service_role;

create or replace function public.accept_group_invite(p_token_hash text, p_user_id uuid)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare invite_row public.group_invites%rowtype;
begin
  if p_token_hash is null or length(p_token_hash) <> 64 or p_user_id is null then
    raise exception 'invalid_invite';
  end if;
  select * into invite_row from public.group_invites where token_hash = p_token_hash for update;
  if not found or invite_row.revoked_at is not null or invite_row.expires_at <= now() or invite_row.use_count >= invite_row.max_uses then
    raise exception 'invite_unavailable';
  end if;
  if not exists (select 1 from public.conversations c where c.id = invite_row.conversation_id and c.is_group = true) then
    raise exception 'group_unavailable';
  end if;
  if exists (select 1 from public.conversation_participants cp where cp.conversation_id = invite_row.conversation_id and cp.user_id = p_user_id) then
    return invite_row.conversation_id;
  end if;
  insert into public.conversation_participants (conversation_id, user_id, is_admin)
  values (invite_row.conversation_id, p_user_id, false)
  on conflict (conversation_id, user_id) do nothing;
  update public.group_invites set use_count = use_count + 1 where id = invite_row.id;
  return invite_row.conversation_id;
end;
$$;
revoke all on function public.accept_group_invite(text, uuid) from public, anon, authenticated;
grant execute on function public.accept_group_invite(text, uuid) to service_role;


-- ===== supabase/migrations/0021_channels.sql =====
-- Public broadcast channels. All table access is mediated by the authenticated API
-- (service role); clients cannot bypass ownership/subscription checks via PostgREST.
create table if not exists public.channels (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references public.profiles(id) on delete cascade,
  title text not null check (char_length(btrim(title)) between 2 and 60),
  description text not null default '' check (char_length(description) <= 500),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists channels_recent_idx on public.channels (created_at desc);

create table if not exists public.channel_subscriptions (
  channel_id uuid not null references public.channels(id) on delete cascade,
  user_id uuid not null references public.profiles(id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (channel_id, user_id)
);
create index if not exists channel_subscriptions_user_idx on public.channel_subscriptions (user_id, created_at desc);

create table if not exists public.channel_posts (
  id uuid primary key default gen_random_uuid(),
  channel_id uuid not null references public.channels(id) on delete cascade,
  author_id uuid not null references public.profiles(id) on delete cascade,
  body text not null check (char_length(btrim(body)) between 1 and 4000),
  created_at timestamptz not null default now(),
  edited_at timestamptz
);
create index if not exists channel_posts_recent_idx on public.channel_posts (channel_id, created_at desc);

alter table public.channels enable row level security;
alter table public.channel_subscriptions enable row level security;
alter table public.channel_posts enable row level security;
revoke all on public.channels, public.channel_subscriptions, public.channel_posts from anon, authenticated;
grant select, insert, update, delete on public.channels, public.channel_subscriptions, public.channel_posts to service_role;
