-- Public broadcast channels. All table access is mediated by the authenticated API
-- (service role); clients cannot bypass ownership/subscription checks via PostgREST.
create table if not exists public.channels (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references public.profiles(id) on delete cascade,
  title text not null check (char_length(btrim(title)) between 2 and 60),
  description text not null default '' check (char_length(description) <= 500),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists channels_recent_idx on public.channels (created_at desc);

create table if not exists public.channel_subscriptions (
  channel_id uuid not null references public.channels(id) on delete cascade,
  user_id uuid not null references public.profiles(id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (channel_id, user_id)
);
create index if not exists channel_subscriptions_user_idx on public.channel_subscriptions (user_id, created_at desc);

create table if not exists public.channel_posts (
  id uuid primary key default gen_random_uuid(),
  channel_id uuid not null references public.channels(id) on delete cascade,
  author_id uuid not null references public.profiles(id) on delete cascade,
  body text not null check (char_length(btrim(body)) between 1 and 4000),
  created_at timestamptz not null default now(),
  edited_at timestamptz
);
create index if not exists channel_posts_recent_idx on public.channel_posts (channel_id, created_at desc);

alter table public.channels enable row level security;
alter table public.channel_subscriptions enable row level security;
alter table public.channel_posts enable row level security;
revoke all on public.channels, public.channel_subscriptions, public.channel_posts from anon, authenticated;
grant select, insert, update, delete on public.channels, public.channel_subscriptions, public.channel_posts to service_role;
