-- Authenticated users can report channel posts; only owners/moderators review via the backend service role.
create table if not exists public.channel_post_reports (
  id uuid primary key default gen_random_uuid(),
  post_id uuid not null references public.channel_posts(id) on delete cascade,
  channel_id uuid not null references public.channels(id) on delete cascade,
  reporter_id uuid not null references public.profiles(id) on delete cascade,
  reason text not null check (reason in ('spam', 'harassment', 'hate', 'misinformation', 'other')),
  details text check (details is null or char_length(details) <= 500),
  status text not null default 'open' check (status in ('open', 'reviewed', 'dismissed')),
  created_at timestamptz not null default now(),
  reviewed_by uuid references public.profiles(id) on delete set null,
  reviewed_at timestamptz,
  unique (post_id, reporter_id)
);
create index if not exists channel_post_reports_open_idx on public.channel_post_reports (channel_id, status, created_at asc);
alter table public.channel_post_reports enable row level security;
revoke all on public.channel_post_reports from public, anon, authenticated;
grant select, insert, update, delete on public.channel_post_reports to service_role;
