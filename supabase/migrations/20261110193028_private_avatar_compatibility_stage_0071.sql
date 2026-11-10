-- Stage 1 of private-avatar transition. Existing public avatars and URLs remain
-- untouched so old clients and cached links continue to work during rollout.
-- New clients may dual-write here and later cut over after signed-URL validation.
alter table public.profile_details add column if not exists avatar_path text;

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('private-avatars', 'private-avatars', false, 10485760,
        array['image/jpeg','image/png','image/webp']::text[])
on conflict (id) do update set
  public = false,
  file_size_limit = excluded.file_size_limit,
  allowed_mime_types = excluded.allowed_mime_types;

create or replace function public.can_view_profile_avatar(p_user_id uuid)
returns boolean
language plpgsql
stable
security definer
set search_path = pg_catalog, public
as $$
declare
  v_viewer uuid := auth.uid();
  v_visibility text;
  v_is_contact boolean := false;
begin
  if v_viewer is null or p_user_id is null then return false; end if;
  if v_viewer = p_user_id then return true; end if;
  if exists (
    select 1 from public.blocked_users b
    where (b.blocker_id = v_viewer and b.blocked_id = p_user_id)
       or (b.blocker_id = p_user_id and b.blocked_id = v_viewer)
  ) then return false; end if;
  select coalesce(d.photo_visibility, 'everyone') into v_visibility
  from public.profile_details d where d.user_id = p_user_id;
  v_visibility := coalesce(v_visibility, 'everyone');
  if v_visibility = 'nobody' then return false; end if;
  select exists (
    select 1 from public.conversation_participants a
    join public.conversation_participants b on b.conversation_id = a.conversation_id
    where a.user_id = v_viewer and b.user_id = p_user_id
  ) into v_is_contact;
  return v_visibility = 'everyone' or (v_visibility = 'contacts' and v_is_contact);
end;
$$;
revoke all on function public.can_view_profile_avatar(uuid) from public, anon;
grant execute on function public.can_view_profile_avatar(uuid) to authenticated;

drop policy if exists "Private avatar owner upload" on storage.objects;
create policy "Private avatar owner upload" on storage.objects
  for insert to authenticated with check (
    bucket_id = 'private-avatars'
    and (storage.foldername(name))[1] = (select auth.uid())::text
  );
drop policy if exists "Private avatar owner update" on storage.objects;
create policy "Private avatar owner update" on storage.objects
  for update to authenticated using (
    bucket_id = 'private-avatars'
    and (storage.foldername(name))[1] = (select auth.uid())::text
  ) with check (
    bucket_id = 'private-avatars'
    and (storage.foldername(name))[1] = (select auth.uid())::text
  );
drop policy if exists "Private avatar owner delete" on storage.objects;
create policy "Private avatar owner delete" on storage.objects
  for delete to authenticated using (
    bucket_id = 'private-avatars'
    and (storage.foldername(name))[1] = (select auth.uid())::text
  );
drop policy if exists "Private avatar visible by profile preference" on storage.objects;
create policy "Private avatar visible by profile preference" on storage.objects
  for select to authenticated using (
    bucket_id = 'private-avatars'
    and public.can_view_profile_avatar(((storage.foldername(name))[1])::uuid)
  );

-- Deliberately do not revoke profiles SELECT, alter avatars bucket visibility,
-- rewrite avatar_url, or delete/rename any existing object in this stage.

create or replace function public.get_visible_profile_avatar_path(p_user_id uuid)
returns text
language sql
stable
security definer
set search_path = pg_catalog, public
as $$
  select d.avatar_path
  from public.profile_details d
  where d.user_id = p_user_id
    and public.can_view_profile_avatar(p_user_id)
  limit 1;
$$;
revoke all on function public.get_visible_profile_avatar_path(uuid) from public, anon;
grant execute on function public.get_visible_profile_avatar_path(uuid) to authenticated;
