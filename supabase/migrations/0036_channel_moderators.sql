-- Channel moderators are appointed only by the channel owner through the authenticated API.
create table if not exists public.channel_moderators (
  channel_id uuid not null references public.channels(id) on delete cascade,
  user_id uuid not null references public.profiles(id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (channel_id, user_id)
);
create index if not exists channel_moderators_user_idx on public.channel_moderators (user_id, created_at desc);
alter table public.channel_moderators enable row level security;
revoke all on public.channel_moderators from anon, authenticated;
grant select, insert, update, delete on public.channel_moderators to service_role;
