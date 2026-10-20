-- Per-owner Story privacy exclusions. Applies to existing active Stories and private media.
create table if not exists public.status_excluded_users (
  owner_id uuid not null references auth.users(id) on delete cascade,
  excluded_user_id uuid not null references auth.users(id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (owner_id, excluded_user_id),
  constraint status_excluded_users_no_self check (owner_id <> excluded_user_id)
);
create index if not exists status_excluded_users_viewer_idx on public.status_excluded_users(excluded_user_id, owner_id);
alter table public.status_excluded_users enable row level security;
revoke all on public.status_excluded_users from anon, authenticated;
grant select, insert, delete on public.status_excluded_users to authenticated;
drop policy if exists "Users manage their own status exclusions" on public.status_excluded_users;
create policy "Users manage their own status exclusions" on public.status_excluded_users for all to authenticated
using (owner_id = (select auth.uid()))
with check (owner_id = (select auth.uid()) and owner_id <> excluded_user_id);

-- Replace the contact-status policy so exclusion is enforced by the database, not just the UI.
drop policy if exists "Conversation contacts can read contact statuses" on public.status_updates;
create policy "Conversation contacts can read contact statuses" on public.status_updates for select to authenticated using (
 audience = 'contacts' and expires_at > now() and user_id <> (select auth.uid())
 and not exists (select 1 from public.status_excluded_users x where x.owner_id = status_updates.user_id and x.excluded_user_id = (select auth.uid()))
 and exists (select 1 from public.conversation_participants mine join public.conversation_participants theirs on theirs.conversation_id = mine.conversation_id
   where mine.user_id = (select auth.uid()) and theirs.user_id = status_updates.user_id)
);

-- Storage signed URLs are only issued when the caller passes this RLS policy.
drop policy if exists "Status media visible to authorized viewers" on storage.objects;
create policy "Status media visible to authorized viewers" on storage.objects for select to authenticated using (
 bucket_id = 'status-media' and exists (
  select 1 from public.status_updates s where s.id::text = (storage.foldername(name))[2]
   and s.user_id::text = (storage.foldername(name))[1] and s.media_path = name and s.expires_at > now()
   and s.media_kind in ('image','video') and (s.user_id = auth.uid() or (
    s.audience = 'contacts'
    and not exists (select 1 from public.status_excluded_users x where x.owner_id = s.user_id and x.excluded_user_id = (select auth.uid()))
    and exists (select 1 from public.conversation_participants mine join public.conversation_participants theirs on theirs.conversation_id = mine.conversation_id
      where mine.user_id = (select auth.uid()) and theirs.user_id = s.user_id)
   ))
 )
);

-- Receipt, reaction and reply writes must respect the same exclusion preference.
drop policy if exists "Eligible viewers can record own view" on public.status_views;
create policy "Eligible viewers can record own view" on public.status_views for insert to authenticated with check (
 viewer_id = (select auth.uid()) and exists (select 1 from public.status_updates s where s.id = status_views.status_id
  and s.user_id <> (select auth.uid()) and s.expires_at > now() and s.audience = 'contacts'
  and not exists (select 1 from public.status_excluded_users x where x.owner_id = s.user_id and x.excluded_user_id = (select auth.uid()))
  and exists (select 1 from public.conversation_participants mine join public.conversation_participants theirs on theirs.conversation_id = mine.conversation_id
   where mine.user_id = (select auth.uid()) and theirs.user_id = s.user_id))
);

drop policy if exists "Eligible viewers can read status reactions" on public.status_reactions;
create policy "Eligible viewers can read status reactions" on public.status_reactions for select to authenticated using (
 exists (select 1 from public.status_updates s where s.id = status_reactions.status_id and s.expires_at > now()
  and (s.user_id = (select auth.uid()) or (s.audience = 'contacts'
   and not exists (select 1 from public.status_excluded_users x where x.owner_id = s.user_id and x.excluded_user_id = (select auth.uid()))
   and exists (select 1 from public.conversation_participants mine join public.conversation_participants theirs on theirs.conversation_id = mine.conversation_id
    where mine.user_id = (select auth.uid()) and theirs.user_id = s.user_id))))
);
drop policy if exists "Eligible viewers can react to statuses" on public.status_reactions;
create policy "Eligible viewers can react to statuses" on public.status_reactions for insert to authenticated with check (
 viewer_id = (select auth.uid()) and exists (select 1 from public.status_updates s where s.id = status_reactions.status_id and s.user_id <> (select auth.uid()) and s.expires_at > now() and s.audience = 'contacts'
  and not exists (select 1 from public.status_excluded_users x where x.owner_id = s.user_id and x.excluded_user_id = (select auth.uid()))
  and exists (select 1 from public.conversation_participants mine join public.conversation_participants theirs on theirs.conversation_id = mine.conversation_id where mine.user_id = (select auth.uid()) and theirs.user_id = s.user_id))
);
drop policy if exists "Viewers can change own status reaction" on public.status_reactions;
create policy "Viewers can change own status reaction" on public.status_reactions for update to authenticated using (
 viewer_id = (select auth.uid()) and exists (select 1 from public.status_updates s where s.id = status_reactions.status_id and s.expires_at > now() and s.user_id <> (select auth.uid()) and s.audience = 'contacts'
  and not exists (select 1 from public.status_excluded_users x where x.owner_id = s.user_id and x.excluded_user_id = (select auth.uid()))
  and exists (select 1 from public.conversation_participants mine join public.conversation_participants theirs on theirs.conversation_id = mine.conversation_id where mine.user_id = (select auth.uid()) and theirs.user_id = s.user_id))
) with check (viewer_id = (select auth.uid()) and exists (select 1 from public.status_updates s where s.id = status_reactions.status_id and s.expires_at > now() and s.user_id <> (select auth.uid()) and s.audience = 'contacts'
  and not exists (select 1 from public.status_excluded_users x where x.owner_id = s.user_id and x.excluded_user_id = (select auth.uid()))
  and exists (select 1 from public.conversation_participants mine join public.conversation_participants theirs on theirs.conversation_id = mine.conversation_id where mine.user_id = (select auth.uid()) and theirs.user_id = s.user_id)));

drop policy if exists "Eligible viewers can reply to statuses" on public.status_replies;
create policy "Eligible viewers can reply to statuses" on public.status_replies for insert to authenticated with check (
 sender_id = (select auth.uid()) and char_length(trim(body)) between 1 and 1000
 and exists (select 1 from public.status_updates s where s.id = status_replies.status_id and s.user_id <> (select auth.uid()) and s.expires_at > now() and s.audience = 'contacts'
  and not exists (select 1 from public.status_excluded_users x where x.owner_id = s.user_id and x.excluded_user_id = (select auth.uid()))
  and exists (select 1 from public.conversation_participants mine join public.conversation_participants theirs on theirs.conversation_id = mine.conversation_id where mine.user_id = (select auth.uid()) and theirs.user_id = s.user_id))
);
