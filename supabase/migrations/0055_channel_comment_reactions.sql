-- Comment reactions are one reaction per user/comment; writes are backend-mediated.
create table if not exists public.channel_comment_reactions (
  comment_id uuid not null references public.channel_post_comments(id) on delete cascade,
  user_id uuid not null references public.profiles(id) on delete cascade,
  emoji text not null check (emoji in ('👍','❤️','😂','😮','👏')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (comment_id, user_id)
);
create index if not exists channel_comment_reactions_comment_idx on public.channel_comment_reactions (comment_id, emoji);
alter table public.channel_comment_reactions enable row level security;
revoke all on public.channel_comment_reactions from anon, authenticated;
grant select, insert, update, delete on public.channel_comment_reactions to service_role;
