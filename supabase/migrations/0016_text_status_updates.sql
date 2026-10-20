-- Text-only Status/Stories foundation. Media stories and viewer receipts are intentionally
-- separate future work; this migration does not expose public storage URLs.
create table if not exists public.status_updates (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles(id) on delete cascade,
  text text not null check (char_length(btrim(text)) between 1 and 700),
  audience text not null default 'contacts' check (audience in ('contacts', 'only_me')),
  created_at timestamptz not null default now(),
  expires_at timestamptz not null default (now() + interval '24 hours'),
  constraint status_expiry_window check (expires_at > created_at and expires_at <= created_at + interval '24 hours')
);

create index if not exists status_updates_expiry_idx on public.status_updates (expires_at);
create index if not exists status_updates_user_created_idx on public.status_updates (user_id, created_at desc);
alter table public.status_updates enable row level security;

-- The author can see their own active statuses, including private ones.
drop policy if exists "Status author can read own updates" on public.status_updates;
create policy "Status author can read own updates" on public.status_updates
  for select to authenticated using (user_id = (select auth.uid()) and expires_at > now());

-- Contacts are defined conservatively as users who share a conversation.
-- 'only_me' entries are never visible to anyone except their author.
drop policy if exists "Conversation contacts can read contact statuses" on public.status_updates;
create policy "Conversation contacts can read contact statuses" on public.status_updates
  for select to authenticated using (
    audience = 'contacts' and expires_at > now() and user_id <> (select auth.uid())
    and exists (
      select 1 from public.conversation_participants mine
      join public.conversation_participants theirs on theirs.conversation_id = mine.conversation_id
      where mine.user_id = (select auth.uid()) and theirs.user_id = status_updates.user_id
    )
  );

drop policy if exists "Users can publish own statuses" on public.status_updates;
create policy "Users can publish own statuses" on public.status_updates
  for insert to authenticated with check (
    user_id = (select auth.uid()) and expires_at > now()
    and expires_at <= created_at + interval '24 hours'
    and char_length(btrim(text)) between 1 and 700
  );

drop policy if exists "Users can delete own statuses" on public.status_updates;
create policy "Users can delete own statuses" on public.status_updates
  for delete to authenticated using (user_id = (select auth.uid()));

revoke all on public.status_updates from anon;
grant select, insert, delete on public.status_updates to authenticated;
