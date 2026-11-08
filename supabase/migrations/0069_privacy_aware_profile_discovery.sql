-- Privacy-aware profile discovery projection.
-- Additive: preserves profiles and existing grants while moving app discovery
-- reads onto a narrowly scoped server projection. Avatar URLs are deliberately
-- omitted until legacy public avatar storage is migrated to private access.

create or replace function public.get_contact_directory(p_user_id uuid default null)
returns table (
  id uuid,
  name text,
  avatar_color text,
  username text
)
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_viewer uuid := auth.uid();
begin
  if v_viewer is null then
    raise exception 'Authentication required' using errcode = '42501';
  end if;

  if p_user_id is not null and p_user_id = v_viewer then
    raise exception 'Cannot discover your own profile' using errcode = '22023';
  end if;

  return query
  select p.id, p.name, p.avatar_color, p.username
  from public.profiles p
  left join public.profile_details d on d.user_id = p.id
  where p.id <> v_viewer
    and (p_user_id is null or p.id = p_user_id)
    and coalesce(d.profile_visibility, 'everyone') <> 'nobody'
    and (
      coalesce(d.profile_visibility, 'everyone') = 'everyone'
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
    )
  order by p.name, p.id;
end;
$$;

revoke all on function public.get_contact_directory(uuid) from public, anon;
grant execute on function public.get_contact_directory(uuid) to authenticated;
comment on function public.get_contact_directory(uuid) is
  'Returns only minimal identity fields for profiles visible to the caller; excludes self and either-direction blocks. Does not expose avatar URLs or profile detail fields.';
