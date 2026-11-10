-- ZannyChat 1.2.239: move profile covers to private storage.
-- Additive only: existing public cover objects and URLs are not deleted or revoked.

alter table public.profile_details
  add column if not exists cover_path text;

-- Never expose either a permanent public cover URL or a private storage path
-- through the public profile projection, including to the profile owner.
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
  if v_viewer is null then
    raise exception 'Authentication required' using errcode = '42501';
  end if;

  if exists (
    select 1
    from public.blocked_users b
    where (b.blocker_id = v_viewer and b.blocked_id = p_user_id)
       or (b.blocker_id = p_user_id and b.blocked_id = v_viewer)
  ) then
    return '{}'::jsonb;
  end if;

  select * into v_details
  from public.profile_details
  where user_id = p_user_id;

  if not found then return '{}'::jsonb; end if;

  if v_viewer = p_user_id then
    return to_jsonb(v_details) - 'user_id' - 'cover_image_url' - 'cover_path';
  end if;

  select exists (
    select 1
    from public.conversation_participants a
    join public.conversation_participants b
      on b.conversation_id = a.conversation_id
    where a.user_id = v_viewer
      and b.user_id = p_user_id
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
    'show_last_seen', v_details.show_last_seen,
    'show_online_status', v_details.show_online_status,
    'show_read_receipts', v_details.show_read_receipts
  ));
end;
$$;

revoke all on function public.get_public_profile_details(uuid) from public, anon;
grant execute on function public.get_public_profile_details(uuid) to authenticated;

-- A cover requires both profile visibility and photo visibility. This also
-- prevents a photo_visibility=everyone setting from bypassing profile_visibility.
create or replace function public.get_visible_profile_cover_path(p_user_id uuid)
returns text
language sql
stable
security definer
set search_path = pg_catalog, public
as $$
  select d.cover_path
  from public.profile_details d
  where d.user_id = p_user_id
    and public.can_view_profile_avatar(p_user_id)
    and public.get_public_profile_details(p_user_id) <> '{}'::jsonb
  limit 1;
$$;

revoke all on function public.get_visible_profile_cover_path(uuid) from public, anon;
grant execute on function public.get_visible_profile_cover_path(uuid) to authenticated;
