-- Subscriber discussion comments on public channel posts.
create table if not exists public.channel_post_comments (
  id uuid primary key default gen_random_uuid(),
  post_id uuid not null references public.channel_posts(id) on delete cascade,
  user_id uuid not null references public.profiles(id) on delete cascade,
  body text not null check (char_length(btrim(body)) between 1 and 1000),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists channel_post_comments_recent_idx on public.channel_post_comments (post_id, created_at asc);
alter table public.channel_post_comments enable row level security;
revoke all on public.channel_post_comments from anon, authenticated;
grant select, insert, update, delete on public.channel_post_comments to service_role;
