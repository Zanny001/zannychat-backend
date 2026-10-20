-- Authenticated channel post reactions; writes are mediated by the backend service role.
create table if not exists public.channel_post_reactions (
  post_id uuid not null references public.channel_posts(id) on delete cascade,
  user_id uuid not null references public.profiles(id) on delete cascade,
  emoji text not null check (emoji in ('👍','❤️','😂','😮','👏')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (post_id, user_id)
);
create index if not exists channel_post_reactions_post_idx on public.channel_post_reactions (post_id, emoji);
alter table public.channel_post_reactions enable row level security;
revoke all on public.channel_post_reactions from anon, authenticated;
grant select, insert, update, delete on public.channel_post_reactions to service_role;
