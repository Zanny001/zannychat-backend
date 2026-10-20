-- Count distinct authenticated users who have opened each channel post.
-- Repeated loads by the same user do not inflate counts.
create table if not exists public.channel_post_views (
  post_id uuid not null references public.channel_posts(id) on delete cascade,
  user_id uuid not null references public.profiles(id) on delete cascade,
  viewed_at timestamptz not null default now(),
  primary key (post_id, user_id)
);
create index if not exists channel_post_views_post_idx on public.channel_post_views(post_id);
alter table public.channel_post_views enable row level security;
revoke all on public.channel_post_views from anon, authenticated;
grant select, insert, update, delete on public.channel_post_views to service_role;
