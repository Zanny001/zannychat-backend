-- Emoji reactions for active status updates. Each viewer may keep one reaction per status.
create table if not exists public.status_reactions (
  status_id uuid not null references public.status_updates(id) on delete cascade,
  viewer_id uuid not null references public.profiles(id) on delete cascade,
  reaction text not null check (reaction in ('❤️','😂','😮','😢','👏','🔥')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (status_id, viewer_id)
);
create index if not exists status_reactions_status_idx on public.status_reactions(status_id);
alter table public.status_reactions enable row level security;
drop policy if exists "Eligible viewers can read status reactions" on public.status_reactions;
create policy "Eligible viewers can read status reactions" on public.status_reactions for select to authenticated using (
  exists (select 1 from public.status_updates s where s.id = status_reactions.status_id and s.expires_at > now() and (s.user_id = (select auth.uid()) or (s.audience = 'contacts' and exists (select 1 from public.conversation_participants mine join public.conversation_participants theirs on theirs.conversation_id = mine.conversation_id where mine.user_id = (select auth.uid()) and theirs.user_id = s.user_id))))
);
drop policy if exists "Eligible viewers can react to statuses" on public.status_reactions;
create policy "Eligible viewers can react to statuses" on public.status_reactions for insert to authenticated with check (viewer_id = (select auth.uid()) and exists (select 1 from public.status_updates s where s.id = status_reactions.status_id and s.user_id <> (select auth.uid()) and s.expires_at > now() and s.audience = 'contacts' and exists (select 1 from public.conversation_participants mine join public.conversation_participants theirs on theirs.conversation_id = mine.conversation_id where mine.user_id = (select auth.uid()) and theirs.user_id = s.user_id)));
drop policy if exists "Viewers can change own status reaction" on public.status_reactions;
create policy "Viewers can change own status reaction" on public.status_reactions for update to authenticated using (viewer_id = (select auth.uid()) and exists (select 1 from public.status_updates s where s.id = status_reactions.status_id and s.expires_at > now() and s.user_id <> (select auth.uid()) and s.audience = 'contacts' and exists (select 1 from public.conversation_participants mine join public.conversation_participants theirs on theirs.conversation_id = mine.conversation_id where mine.user_id = (select auth.uid()) and theirs.user_id = s.user_id))) with check (viewer_id = (select auth.uid()) and exists (select 1 from public.status_updates s where s.id = status_reactions.status_id and s.expires_at > now() and s.user_id <> (select auth.uid()) and s.audience = 'contacts' and exists (select 1 from public.conversation_participants mine join public.conversation_participants theirs on theirs.conversation_id = mine.conversation_id where mine.user_id = (select auth.uid()) and theirs.user_id = s.user_id)));
drop policy if exists "Viewers can remove own status reaction" on public.status_reactions;
create policy "Viewers can remove own status reaction" on public.status_reactions for delete to authenticated using (viewer_id = (select auth.uid()));
revoke all on public.status_reactions from anon;
revoke all on public.status_reactions from authenticated;
grant select, insert, update, delete on public.status_reactions to authenticated;
