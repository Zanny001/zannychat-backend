-- Per-account preference to hide another user's statuses from the viewer's feed.
create table if not exists public.muted_status_users (
  user_id uuid not null references auth.users(id) on delete cascade,
  muted_user_id uuid not null references auth.users(id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (user_id, muted_user_id),
  constraint muted_status_users_no_self check (user_id <> muted_user_id)
);

alter table public.muted_status_users enable row level security;
revoke all on public.muted_status_users from anon, authenticated;
grant select, insert, update, delete on public.muted_status_users to authenticated;
drop policy if exists "Users manage their own status mutes" on public.muted_status_users;
create policy "Users manage their own status mutes" on public.muted_status_users
  for all to authenticated
  using (user_id = (select auth.uid()))
  with check (user_id = (select auth.uid()) and user_id <> muted_user_id);
