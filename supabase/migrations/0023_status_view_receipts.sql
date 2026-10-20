-- Status view receipts: viewers may record only their own view of a status
-- they are already authorized to read; only the status owner can read receipts.
create table if not exists public.status_views (
  status_id uuid not null references public.status_updates(id) on delete cascade,
  viewer_id uuid not null references public.profiles(id) on delete cascade,
  viewed_at timestamptz not null default now(),
  primary key (status_id, viewer_id)
);
create index if not exists status_views_status_viewed_idx on public.status_views(status_id, viewed_at desc);
alter table public.status_views enable row level security;

 drop policy if exists "Status owner can read view receipts" on public.status_views;
create policy "Status owner can read view receipts" on public.status_views
  for select to authenticated using (
    exists (select 1 from public.status_updates s where s.id = status_views.status_id and s.user_id = (select auth.uid()))
  );
drop policy if exists "Eligible viewers can record own view" on public.status_views;
create policy "Eligible viewers can record own view" on public.status_views
  for insert to authenticated with check (
    viewer_id = (select auth.uid())
    and exists (select 1 from public.status_updates s where s.id = status_views.status_id
      and s.user_id <> (select auth.uid()) and s.expires_at > now()
      and s.audience = 'contacts' and exists (
        select 1 from public.conversation_participants mine
        join public.conversation_participants theirs on theirs.conversation_id = mine.conversation_id
        where mine.user_id = (select auth.uid()) and theirs.user_id = s.user_id
      ))
  );
revoke all on public.status_views from anon;
revoke all on public.status_views from authenticated;
grant select, insert on public.status_views to authenticated;
