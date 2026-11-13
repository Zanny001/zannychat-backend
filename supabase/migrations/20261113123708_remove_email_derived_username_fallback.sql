-- Do not derive public usernames from email-address prefixes.
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
    'ZannyChat User'
  );

  v_base := left(regexp_replace(lower(v_name), '[^a-z0-9_]', '', 'g'), 14);
  if length(v_base) < 3 then
    v_base := 'zannyuser';
  end if;
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

-- Replace usernames generated from email local parts when provider display
-- metadata was absent. Preserve the user's profile name and account identity.
update public.profiles p
set username = 'zannyuser' || substr(replace(p.id::text, '-', ''), 1, 8)
from auth.users u
where u.id = p.id
  and nullif(btrim(u.raw_user_meta_data ->> 'name'), '') is null
  and nullif(btrim(u.raw_user_meta_data ->> 'full_name'), '') is null
  and nullif(btrim(u.raw_user_meta_data ->> 'display_name'), '') is null
  and p.username = (
    case
      when length(left(regexp_replace(lower(split_part(coalesce(u.email, ''), '@', 1)), '[^a-z0-9_]', '', 'g'), 14)) < 3
        then 'user'
      else left(regexp_replace(lower(split_part(coalesce(u.email, ''), '@', 1)), '[^a-z0-9_]', '', 'g'), 14)
    end
  ) || substr(replace(p.id::text, '-', ''), 1, 8);

commit;
