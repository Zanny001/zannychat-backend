-- Resolve a QR identity to a profile without requiring an existing conversation.
-- Mirrors public people-search visibility and block checks.
begin;

create or replace function public.get_public_profile_by_id(p_user_id uuid)
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
begin
  if v_viewer is null then
    raise exception 'Authentication required' using errcode = '42501';
  end if;
  if p_user_id is null or p_user_id = v_viewer then
    return;
  end if;

  return query
  select p.id, p.name, p.username, p.avatar_color,
    case when public.can_view_profile_avatar(p.id) then p.avatar_url else null end,
    p.status,
    case when coalesce(d.show_online_status, true) then p.online else false end
  from public.profiles p
  left join public.profile_details d on d.user_id = p.id
  where p.id = p_user_id
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
      select 1 from public.blocked_users b
      where (b.blocker_id = v_viewer and b.blocked_id = p.id)
         or (b.blocker_id = p.id and b.blocked_id = v_viewer)
    );
end;
$function$;

revoke all on function public.get_public_profile_by_id(uuid) from public;
revoke all on function public.get_public_profile_by_id(uuid) from anon;
grant execute on function public.get_public_profile_by_id(uuid) to authenticated;

commit;
