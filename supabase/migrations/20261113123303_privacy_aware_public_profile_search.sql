-- Authenticated, privacy-aware people search for the New Chat directory.
-- Never returns email addresses, phone numbers, auth metadata, or private profile fields.
begin;

create or replace function public.search_public_profiles(
  p_query text,
  p_limit integer default 20,
  p_offset integer default 0
)
returns table (
  id uuid,
  name text,
  username text,
  avatar_color text,
  avatar_url text,
  status text,
  online boolean
)
language plpgsql
stable
security definer
set search_path = ''
as $function$
declare
  v_viewer uuid := auth.uid();
  v_query text := lower(btrim(coalesce(p_query, '')));
  v_limit integer := greatest(1, least(coalesce(p_limit, 20), 30));
  v_offset integer := greatest(0, least(coalesce(p_offset, 0), 1000));
begin
  if v_viewer is null then
    raise exception 'Authentication required' using errcode = '42501';
  end if;

  if length(v_query) < 2 or length(v_query) > 40 then
    return;
  end if;

  return query
  select
    p.id,
    p.name,
    p.username,
    p.avatar_color,
    case
      when public.can_view_profile_avatar(p.id) then p.avatar_url
      else null
    end,
    p.status,
    case
      when coalesce(d.show_online_status, true) then p.online
      else false
    end
  from public.profiles p
  left join public.profile_details d on d.user_id = p.id
  where p.id <> v_viewer
    and (
      left(lower(p.username), length(v_query)) = v_query
      or position(v_query in lower(p.name)) > 0
    )
    and coalesce(d.profile_visibility, 'everyone') <> 'nobody'
    and (
      coalesce(d.profile_visibility, 'everyone') <> 'contacts'
      or exists (
        select 1
        from public.conversation_participants mine
        join public.conversation_participants theirs
          on theirs.conversation_id = mine.conversation_id
        where mine.user_id = v_viewer
          and theirs.user_id = p.id
      )
    )
    and not exists (
      select 1
      from public.blocked_users b
      where (b.blocker_id = v_viewer and b.blocked_id = p.id)
         or (b.blocker_id = p.id and b.blocked_id = v_viewer)
    )
  order by
    case when left(lower(p.username), length(v_query)) = v_query then 0 else 1 end,
    p.name asc,
    p.id asc
  limit v_limit
  offset v_offset;
end;
$function$;

revoke all on function public.search_public_profiles(text, integer, integer) from public;
revoke all on function public.search_public_profiles(text, integer, integer) from anon;
grant execute on function public.search_public_profiles(text, integer, integer) to authenticated;

commit;
