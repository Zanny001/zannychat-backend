-- Extend channel moderation reports to support comments as well as posts.
-- Exactly one target is set, and a user may report each target only once.
alter table public.channel_post_reports add column if not exists comment_id uuid references public.channel_post_comments(id) on delete cascade;
alter table public.channel_post_reports alter column post_id drop not null;
alter table public.channel_post_reports drop constraint if exists channel_post_reports_post_id_reporter_id_key;
alter table public.channel_post_reports add constraint channel_post_reports_exactly_one_target check ((post_id is not null)::int + (comment_id is not null)::int = 1);
create unique index if not exists channel_post_reports_post_reporter_unique on public.channel_post_reports(post_id, reporter_id) where post_id is not null;
create unique index if not exists channel_post_reports_comment_reporter_unique on public.channel_post_reports(comment_id, reporter_id) where comment_id is not null;
create index if not exists channel_comment_reports_open_idx on public.channel_post_reports(channel_id, status, created_at asc) where comment_id is not null;
