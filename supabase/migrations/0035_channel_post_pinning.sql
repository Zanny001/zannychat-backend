-- Allow channel owners to keep important broadcast posts at the top of the feed.
alter table public.channel_posts
  add column if not exists is_pinned boolean not null default false;

create index if not exists channel_posts_pinned_recent_idx
  on public.channel_posts (channel_id, is_pinned desc, created_at desc);
