-- Ensure every authenticated account receives a discoverable, unique username.
-- Existing profile IDs and related records remain unchanged.
begin;

create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_name text;
  v_base text;
  v_username text;
begin
  v_name := coalesce(
    nullif(btrim(new.raw_user_meta_data ->> 'name'), ''),
    nullif(btrim(new.raw_user_meta_data ->> 'full_name'), ''),
    nullif(btrim(new.raw_user_meta_data ->> 'display_name'), ''),
    nullif(split_part(coalesce(new.email, ''), '@', 1), ''),
    'ZannyChat User'
  );

  v_base := left(
    regexp_replace(lower(v_name), '[^a-z0-9_]', '', 'g'),
    14
  );
  if length(v_base) < 3 then
    v_base := 'user';
  end if;

  -- UUID-derived suffix makes concurrent registrations deterministic and
  -- avoids leaking email addresses or phone numbers into public usernames.
  v_username := v_base || substr(replace(new.id::text, '-', ''), 1, 8);

  insert into public.profiles (id, name, username)
  values (new.id, v_name, v_username)
  on conflict (id) do update
    set name = case
      when public.profiles.name is null or btrim(public.profiles.name) = ''
        or public.profiles.name = 'New user'
      then excluded.name
      else public.profiles.name
    end,
    username = coalesce(nullif(btrim(public.profiles.username), ''), excluded.username);

  return new;
end;
$function$;

-- Backfill accounts created before username provisioning existed.
with candidates as (
  select
    p.id,
    left(
      coalesce(
        nullif(
          regexp_replace(
            lower(coalesce(
              nullif(btrim(p.name), ''),
              nullif(btrim(u.raw_user_meta_data ->> 'name'), ''),
              nullif(btrim(u.raw_user_meta_data ->> 'full_name'), ''),
              nullif(split_part(coalesce(u.email, ''), '@', 1), ''),
              'zannyuser'
            )),
            '[^a-z0-9_]', '', 'g'
          ),
          ''
        ),
        'zannyuser'
      ),
      14
    ) as base
  from public.profiles p
  join auth.users u on u.id = p.id
  where p.username is null or btrim(p.username) = ''
),
backfill as (
  select id,
    (case when length(base) < 3 then 'user' else base end)
      || substr(replace(id::text, '-', ''), 1, 8) as username
  from candidates
)
update public.profiles p
set username = b.username
from backfill b
where p.id = b.id
  and (p.username is null or btrim(p.username) = '');

-- Fail closed if any account somehow remains without a username.
do $block$
begin
  if exists (select 1 from public.profiles where username is null or btrim(username) = '') then
    raise exception 'Username backfill incomplete; profiles remain without usernames';
  end if;
end;
$block$;

alter table public.profiles alter column username set not null;

commit;
