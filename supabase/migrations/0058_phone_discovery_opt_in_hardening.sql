-- Harden opt-in phone discovery for existing installations. Keep this as a new
-- migration instead of relying on edits to the already-numbered 0057 migration.
-- Existing explicit opt-ins are preserved; only the column default changes.
alter table public.phone_discovery
  alter column discoverable set default false;

-- Remove stale discovery entries immediately when a verified phone changes or
-- verification is removed. A user must explicitly opt in again for the new phone.
create or replace function public.clear_stale_phone_discovery_enrollment()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.phone is distinct from old.phone
     or (old.phone_confirmed_at is not null and new.phone_confirmed_at is null) then
    delete from public.phone_discovery where user_id = new.id;
  end if;
  return new;
end;
$$;

revoke all on function public.clear_stale_phone_discovery_enrollment() from public, anon, authenticated;

drop trigger if exists clear_stale_phone_discovery_enrollment on auth.users;
create trigger clear_stale_phone_discovery_enrollment
after update of phone, phone_confirmed_at on auth.users
for each row
execute function public.clear_stale_phone_discovery_enrollment();

comment on function public.clear_stale_phone_discovery_enrollment() is
  'Deletes phone discovery opt-in when the verified phone changes or verification is removed.';


-- A persistent per-user fixed-window quota complements the process-local
-- express-rate-limit guard and remains effective across backend instances/restarts.
create table if not exists public.phone_discovery_match_limits (
  user_id uuid primary key references auth.users(id) on delete cascade,
  window_started_at timestamptz not null,
  request_count integer not null check (request_count >= 0)
);

alter table public.phone_discovery_match_limits enable row level security;
revoke all on public.phone_discovery_match_limits from anon, authenticated;

create or replace function public.consume_phone_discovery_match_limit(p_user_id uuid)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  allowed boolean;
  current_window timestamptz := date_trunc('minute', now());
begin
  insert into public.phone_discovery_match_limits (user_id, window_started_at, request_count)
  values (p_user_id, current_window, 1)
  on conflict (user_id) do update
    set window_started_at = case
          when public.phone_discovery_match_limits.window_started_at < current_window then current_window
          else public.phone_discovery_match_limits.window_started_at
        end,
        request_count = case
          when public.phone_discovery_match_limits.window_started_at < current_window then 1
          else public.phone_discovery_match_limits.request_count + 1
        end;

  select request_count <= 3 into allowed
  from public.phone_discovery_match_limits
  where user_id = p_user_id;
  return coalesce(allowed, false);
end;
$$;

revoke all on function public.consume_phone_discovery_match_limit(uuid) from public, anon, authenticated;
grant execute on function public.consume_phone_discovery_match_limit(uuid) to service_role;
comment on function public.consume_phone_discovery_match_limit(uuid) is
  'Atomically enforces a per-user three-request-per-minute phone-discovery quota across backend instances.';
