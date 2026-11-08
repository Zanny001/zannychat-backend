-- ZannyChat 1.2.239: additive profile metadata/privacy and attachment cleanup queue.
-- Safe for existing data: creates new tables/functions and adds one nullable username column.
-- No existing rows, tables, or storage objects are deleted by this migration.

alter table public.profiles add column if not exists username text;
create unique index if not exists profiles_username_lower_unique
  on public.profiles (lower(username)) where username is not null and btrim(username) <> '';

create table if not exists public.profile_details (
  user_id uuid primary key references public.profiles(id) on delete cascade,
  about text not null default '',
  occupation text not null default '',
  location text not null default '',
  website text not null default '',
  birthday date,
  pronouns text not null default '',
  cover_image_url text,
  profile_visibility text not null default 'everyone'
    check (profile_visibility in ('everyone','contacts','nobody')),
  show_location boolean not null default false,
  show_occupation boolean not null default false,
  show_website boolean not null default true,
  show_birthday boolean not null default false,
  show_pronouns boolean not null default true,
  show_last_seen boolean not null default false,
  show_online_status boolean not null default true,
  show_read_receipts boolean not null default true,
  photo_visibility text not null default 'everyone'
    check (photo_visibility in ('everyone','contacts','nobody')),
  group_invite_permission text not null default 'everyone'
    check (group_invite_permission in ('everyone','contacts','nobody')),
  call_permission text not null default 'everyone'
    check (call_permission in ('everyone','contacts','nobody')),
  status_audience text not null default 'contacts'
    check (status_audience in ('everyone','contacts','selected','nobody')),
  updated_at timestamptz not null default now()
);

alter table public.profile_details enable row level security;
revoke all on public.profile_details from anon, authenticated;
grant select, insert, update, delete on public.profile_details to authenticated;
drop policy if exists "Owners manage their private profile details" on public.profile_details;
create policy "Owners manage their private profile details"
  on public.profile_details for all to authenticated
  using (user_id = auth.uid()) with check (user_id = auth.uid());

-- Public projection only returns fields whose individual visibility flags permit it.
-- The full row remains owner-only through RLS above.
create or replace function public.get_public_profile_details(p_user_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = pg_catalog, public
as $$
declare
  v_details public.profile_details%rowtype;
  v_viewer uuid := auth.uid();
  v_is_contact boolean := false;
begin
  if v_viewer is null then raise exception 'Authentication required' using errcode = '42501'; end if;
  if exists (select 1 from public.blocked_users b where
      (b.blocker_id = v_viewer and b.blocked_id = p_user_id) or
      (b.blocker_id = p_user_id and b.blocked_id = v_viewer)) then
    return '{}'::jsonb;
  end if;
  select * into v_details from public.profile_details where user_id = p_user_id;
  if not found then return '{}'::jsonb; end if;
  if v_viewer = p_user_id then
    return to_jsonb(v_details) - 'user_id';
  end if;
  select exists (
    select 1 from public.conversation_participants a
    join public.conversation_participants b on b.conversation_id = a.conversation_id
    where a.user_id = v_viewer and b.user_id = p_user_id
  ) into v_is_contact;
  if v_details.profile_visibility = 'nobody'
     or (v_details.profile_visibility = 'contacts' and not v_is_contact) then
    return '{}'::jsonb;
  end if;
  return jsonb_strip_nulls(jsonb_build_object(
    'about', nullif(v_details.about, ''),
    'occupation', case when v_details.show_occupation then nullif(v_details.occupation, '') end,
    'location', case when v_details.show_location then nullif(v_details.location, '') end,
    'website', case when v_details.show_website then nullif(v_details.website, '') end,
    'birthday', case when v_details.show_birthday then v_details.birthday end,
    'pronouns', case when v_details.show_pronouns then nullif(v_details.pronouns, '') end,
    'cover_image_url', case when v_details.photo_visibility = 'everyone' or (v_details.photo_visibility = 'contacts' and v_is_contact) then v_details.cover_image_url end,
    'show_last_seen', v_details.show_last_seen,
    'show_online_status', v_details.show_online_status,
    'show_read_receipts', v_details.show_read_receipts
  ));
end;
$$;
revoke all on function public.get_public_profile_details(uuid) from public, anon;
grant execute on function public.get_public_profile_details(uuid) to authenticated;

-- A message detach queues a candidate only. A trusted worker rechecks all message
-- references immediately before invoking the Storage API; no storage.objects SQL delete.
create table if not exists public.message_attachment_cleanup (
  id bigint generated always as identity primary key,
  message_id uuid,
  media_url text not null,
  status text not null default 'pending' check (status in ('pending','processing','done','skipped')),
  attempt_count integer not null default 0 check (attempt_count >= 0),
  next_attempt_at timestamptz not null default now(),
  lease_started_at timestamptz,
  last_error text,
  created_at timestamptz not null default now(),
  completed_at timestamptz
);
create index if not exists message_attachment_cleanup_due_idx
  on public.message_attachment_cleanup(status, next_attempt_at, id);
create index if not exists message_attachment_cleanup_url_idx
  on public.message_attachment_cleanup(media_url);
alter table public.message_attachment_cleanup enable row level security;
revoke all on public.message_attachment_cleanup from anon, authenticated;

create or replace function public.queue_detached_message_media()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
begin
  if tg_op = 'DELETE' then
    if old.media_url is not null then
      insert into public.message_attachment_cleanup(message_id, media_url) values (old.id, old.media_url);
    end if;
    return old;
  end if;
  if old.media_url is not null and new.media_url is distinct from old.media_url then
    insert into public.message_attachment_cleanup(message_id, media_url) values (old.id, old.media_url);
  end if;
  return new;
end;
$$;
drop trigger if exists messages_queue_detached_media_update on public.messages;
drop trigger if exists messages_queue_detached_media_delete on public.messages;
create trigger messages_queue_detached_media_update
  after update of media_url on public.messages
  for each row execute function public.queue_detached_message_media();
create trigger messages_queue_detached_media_delete
  after delete on public.messages
  for each row execute function public.queue_detached_message_media();

create or replace function public.claim_message_attachment_cleanup(p_limit integer default 20)
returns table(id bigint, message_id uuid, media_url text, attempt_count integer)
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
begin
  return query
  with candidates as (
    select q.id from public.message_attachment_cleanup q
    where (q.status = 'pending' and q.next_attempt_at <= now())
       or (q.status = 'processing' and q.lease_started_at < now() - interval '10 minutes')
    order by q.next_attempt_at, q.id
    for update skip locked
    limit greatest(1, least(coalesce(p_limit, 20), 100))
  )
  update public.message_attachment_cleanup q
     set status = 'processing', lease_started_at = now()
    from candidates c where q.id = c.id
  returning q.id, q.message_id, q.media_url, q.attempt_count;
end;
$$;
revoke all on function public.claim_message_attachment_cleanup(integer) from public, anon, authenticated;
grant execute on function public.claim_message_attachment_cleanup(integer) to service_role;

-- Durable call invitation queue. Realtime remains the foreground path;
-- the trusted scheduled backend worker delivers invitations for background/closed apps.
create table if not exists public.call_invitation_notifications (
  call_id uuid primary key references public.call_sessions(id) on delete cascade,
  caller_id uuid not null references auth.users(id) on delete cascade,
  callee_id uuid not null references auth.users(id) on delete cascade,
  status text not null default 'pending' check (status in ('pending','processing','delivered','expired')),
  attempt_count integer not null default 0 check (attempt_count >= 0),
  next_attempt_at timestamptz not null default now(),
  lease_started_at timestamptz,
  last_error text,
  created_at timestamptz not null default now(),
  delivered_at timestamptz
);
create index if not exists call_invitation_notifications_due_idx
  on public.call_invitation_notifications(status, next_attempt_at, created_at);
alter table public.call_invitation_notifications enable row level security;
revoke all on public.call_invitation_notifications from anon, authenticated;

create or replace function public.enqueue_call_invitation_notification()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
begin
  if new.status <> 'ringing' then
    return new;
  end if;

  -- Persist invitations for the trusted scheduled backend worker.
  -- No pg_net extension or database HTTP request is required.
  insert into public.call_invitation_notifications(call_id, caller_id, callee_id)
  values (new.id, new.caller_id, new.callee_id)
  on conflict (call_id) do nothing;

  return new;
end;
$$;
drop trigger if exists on_call_session_created_notify on public.call_sessions;
create trigger on_call_session_created_notify after insert on public.call_sessions
  for each row execute function public.enqueue_call_invitation_notification();

create or replace function public.claim_call_invitation_notifications(p_limit integer default 20)
returns table(call_id uuid, caller_id uuid, callee_id uuid, attempt_count integer)
language plpgsql security definer set search_path = pg_catalog, public as $$
begin
  return query
  with candidates as (
    select q.call_id from public.call_invitation_notifications q
    where (q.status = 'pending' and q.next_attempt_at <= now())
       or (q.status = 'processing' and q.lease_started_at < now() - interval '5 minutes')
    order by q.next_attempt_at, q.created_at
    for update skip locked
    limit greatest(1, least(coalesce(p_limit,20),100))
  )
  update public.call_invitation_notifications q
     set status = 'processing', lease_started_at = now()
    from candidates c where q.call_id = c.call_id
  returning q.call_id, q.caller_id, q.callee_id, q.attempt_count;
end;
$$;
revoke all on function public.claim_call_invitation_notifications(integer) from public, anon, authenticated;
grant execute on function public.claim_call_invitation_notifications(integer) to service_role;

-- Username syntax is also enforced in Postgres so direct client requests cannot bypass UI validation.
do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'profiles_username_format_check' and conrelid = 'public.profiles'::regclass) then
    alter table public.profiles add constraint profiles_username_format_check
      check (username is null or username ~ '^[A-Za-z0-9_]{3,24}$');
  end if;
end $$;

-- Enforce call recipient preferences at the database boundary, not only in the UI.
create or replace function public.enforce_call_recipient_privacy()
returns trigger language plpgsql security definer set search_path = pg_catalog, public as $$
declare
  v_permission text;
  v_is_contact boolean;
begin
  select coalesce(pd.call_permission, 'everyone') into v_permission
  from public.profile_details pd where pd.user_id = new.callee_id;
  v_permission := coalesce(v_permission, 'everyone');
  select exists (
    select 1 from public.conversation_participants a
    join public.conversation_participants b on b.conversation_id = a.conversation_id
    where a.user_id = new.caller_id and b.user_id = new.callee_id
  ) into v_is_contact;
  if v_permission = 'nobody' or (v_permission = 'contacts' and not v_is_contact) then
    raise exception 'calls are unavailable for this contact' using errcode = '42501';
  end if;
  return new;
end;
$$;
drop trigger if exists enforce_call_recipient_privacy on public.call_sessions;
create trigger enforce_call_recipient_privacy before insert on public.call_sessions
  for each row execute function public.enforce_call_recipient_privacy();
