-- Enforce the supported Status expiry choices in the database.
-- Client timestamps are inputs only: the server replaces them with server time
-- and the requested supported lifetime. Existing rows are not rewritten.

alter table public.status_updates
  drop constraint if exists status_expiry_window;
alter table public.status_updates
  add constraint status_expiry_window
  check (expires_at > created_at and expires_at <= created_at + interval '48 hours');

create or replace function public.enforce_status_expiry_window()
returns trigger
language plpgsql
set search_path = public
as $$
declare
  requested_seconds double precision;
  server_created_at timestamptz;
begin
  if tg_op = 'UPDATE' then
    if new.created_at is distinct from old.created_at
       or new.expires_at is distinct from old.expires_at then
      raise exception 'Status creation and expiry timestamps cannot be changed after publishing.';
    end if;
    return new;
  end if;

  if new.created_at is null or new.expires_at is null then
    raise exception 'A supported Status expiry must be selected.';
  end if;

  requested_seconds := extract(epoch from (new.expires_at - new.created_at));
  if not (
    abs(requested_seconds - 21600) < 1
    or abs(requested_seconds - 43200) < 1
    or abs(requested_seconds - 86400) < 1
    or abs(requested_seconds - 172800) < 1
  ) then
    raise exception 'Status expiry must be 6, 12, 24, or 48 hours.';
  end if;

  server_created_at := clock_timestamp();
  new.created_at := server_created_at;
  new.expires_at := server_created_at + make_interval(secs => requested_seconds::integer);
  return new;
end;
$$;
revoke all on function public.enforce_status_expiry_window() from public, anon, authenticated;

drop trigger if exists enforce_status_expiry_window on public.status_updates;
create trigger enforce_status_expiry_window
before insert or update of created_at, expires_at on public.status_updates
for each row execute function public.enforce_status_expiry_window();

-- Update older text/photo/video RLS policies to match the current 48-hour UI
-- options. The trigger above limits inserts to the four supported durations.
drop policy if exists "Users can publish own statuses" on public.status_updates;
create policy "Users can publish own statuses" on public.status_updates
for insert to authenticated
with check (
  user_id = (select auth.uid())
  and expires_at > now()
  and expires_at <= created_at + interval '48 hours'
  and (
    (media_kind is null and media_path is null and text is not null and char_length(btrim(text)) between 1 and 700)
    or (media_kind = 'image' and media_path = 'pending' and char_length(btrim(coalesce(text, ''))) <= 700)
    or (media_kind = 'video' and media_path = 'pending' and char_length(btrim(coalesce(text, ''))) <= 700)
  )
);

drop policy if exists "Users can update own media status path" on public.status_updates;
create policy "Users can update own media status path" on public.status_updates
for update to authenticated
using (user_id = (select auth.uid()))
with check (
  user_id = (select auth.uid())
  and expires_at > now()
  and expires_at <= created_at + interval '48 hours'
  and (
    (media_kind = 'image' and media_path = user_id::text || '/' || id::text || '/photo.' || split_part(media_path, '.', 2)
      and split_part(media_path, '.', 2) in ('jpg', 'png', 'webp'))
    or (media_kind = 'video' and media_path = user_id::text || '/' || id::text || '/video.mp4')
  )
);
