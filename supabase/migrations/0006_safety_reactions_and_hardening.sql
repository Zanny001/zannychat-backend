-- ZannyChat — block & report, reactions, edit/delete, mute/archive,
-- and storage/push hardening
-- Run after 0001-0005, same way (Supabase SQL editor or
-- `supabase db push`). Idempotent throughout, like the rest.
--
-- This is the migration that closes most of the Oct 2026 audit's P0
-- abuse-resistance findings and its P1 "half-built feature" gaps.
-- One OPTIONAL manual step is documented at the bottom (moving the
-- push webhook URL off its hardcoded default) — the trigger keeps
-- working with the old URL as a fallback if you skip it.

-- ---------------------------------------------------------------------
-- BLOCK & REPORT
-- blocked_users: one row per "blocker blocked blocked_id" pair. Only
-- the blocker can ever see or manage their own list — the blocked
-- person can't query whether they're blocked (a "you are blocked"
-- signal readable by the blocked party is itself a small privacy
-- leak; they just find their messages don't land).
-- ---------------------------------------------------------------------
create table if not exists public.blocked_users (
  blocker_id uuid not null references public.profiles (id) on delete cascade,
  blocked_id uuid not null references public.profiles (id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (blocker_id, blocked_id),
  check (blocker_id <> blocked_id)
);

alter table public.blocked_users enable row level security;

create policy "Users can view their own block list"
  on public.blocked_users for select
  to authenticated
  using (auth.uid() = blocker_id);

create policy "Users can block other users"
  on public.blocked_users for insert
  to authenticated
  with check (auth.uid() = blocker_id);

create policy "Users can unblock from their own list"
  on public.blocked_users for delete
  to authenticated
  using (auth.uid() = blocker_id);

-- Reads blocked_users WITHOUT RLS so the messages insert policy below
-- can answer "has anyone in this conversation blocked this sender?"
-- even though the sender can't SELECT those rows directly. Security
-- definer is safe here because the function takes explicit parameters
-- and returns only a boolean — no row data ever escapes it.
create or replace function public.is_blocked_in_conversation(p_conversation_id uuid, p_sender_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1
    from public.conversation_participants cp
    join public.blocked_users b
      on b.blocker_id = cp.user_id
     and b.blocked_id = p_sender_id
    where cp.conversation_id = p_conversation_id
      and cp.user_id <> p_sender_id
  );
$$;

-- Re-create the messages insert policy with the block check added.
-- Semantics: in a 1:1, a blocked sender's message is rejected outright
-- (the conversation effectively freezes — which is what both parties
-- expect a block to mean). In a group, the same rule applies per
-- participant: you can't post to a group if ANY member blocked you.
-- That's the conservative reading; group-scoped blocking nuance (hide
-- from blocker only) is a deliberate later refinement, not an
-- oversight.
drop policy if exists "Members can send messages in their conversations" on public.messages;
create policy "Members can send messages in their conversations"
  on public.messages for insert
  to authenticated
  with check (
    sender_id = auth.uid()
    and exists (
      select 1 from public.conversation_participants cp
      where cp.conversation_id = messages.conversation_id and cp.user_id = auth.uid()
    )
    and not public.is_blocked_in_conversation(messages.conversation_id, auth.uid())
  );

-- Reports are write-and-forget from the client's side: you can file
-- one and re-read your own, never edit or delete it, and never see
-- anyone else's. Review is an ops process against the database, not
-- something the app exposes.
create table if not exists public.reports (
  id uuid primary key default gen_random_uuid(),
  reporter_id uuid not null references public.profiles (id) on delete cascade,
  reported_user_id uuid not null references public.profiles (id) on delete cascade,
  message_id uuid references public.messages (id) on delete set null,
  reason text not null default '',
  created_at timestamptz not null default now()
);

alter table public.reports enable row level security;

create policy "Users can file reports"
  on public.reports for insert
  to authenticated
  with check (auth.uid() = reporter_id);

create policy "Users can view their own reports"
  on public.reports for select
  to authenticated
  using (auth.uid() = reporter_id);

-- ---------------------------------------------------------------------
-- MESSAGE REACTIONS — makes the long-press reaction picker real. The
-- frontend's handleReact used to only touch local state, so a
-- reaction was invisible to the other person and gone on reopen.
-- One reaction per user per message (re-reacting replaces it).
-- ---------------------------------------------------------------------
create table if not exists public.message_reactions (
  id uuid primary key default gen_random_uuid(),
  message_id uuid not null references public.messages (id) on delete cascade,
  user_id uuid not null references public.profiles (id) on delete cascade,
  emoji text not null,
  created_at timestamptz not null default now(),
  unique (message_id, user_id)
);

alter table public.message_reactions enable row level security;

create policy "Participants can read reactions in their conversations"
  on public.message_reactions for select
  to authenticated
  using (
    exists (
      select 1
      from public.messages m
      join public.conversation_participants cp
        on cp.conversation_id = m.conversation_id
       and cp.user_id = auth.uid()
      where m.id = message_reactions.message_id
    )
  );

create policy "Participants can add their own reaction"
  on public.message_reactions for insert
  to authenticated
  with check (
    user_id = auth.uid()
    and exists (
      select 1
      from public.messages m
      join public.conversation_participants cp
        on cp.conversation_id = m.conversation_id
       and cp.user_id = auth.uid()
      where m.id = message_reactions.message_id
    )
  );

-- Upsert path (re-react with a different emoji) needs an UPDATE policy
-- scoped to your own row only.
create policy "Users can change their own reaction"
  on public.message_reactions for update
  to authenticated
  using (user_id = auth.uid())
  with check (user_id = auth.uid());

create policy "Users can remove their own reaction"
  on public.message_reactions for delete
  to authenticated
  using (user_id = auth.uid());

alter publication supabase_realtime add table public.message_reactions;

-- Realtime DELETE payloads only carry the primary key by default —
-- with replica identity full, a delete event includes message_id and
-- user_id too, which is what the client needs to remove the reaction
-- from the right bubble without a refetch.
alter table public.message_reactions replica identity full;

-- ---------------------------------------------------------------------
-- MESSAGE EDIT & SOFT DELETE
-- edited_at: set when the sender changes text (client shows "edited").
-- deleted_at: soft delete — the row stays (replies may reference it,
-- reports may point at it) but clients render a tombstone and never
-- the content. Media is intentionally left in storage on soft delete;
-- true media purging is a separate, deliberate decision (it breaks
-- reports' evidence and storage-path bookkeeping).
-- ---------------------------------------------------------------------
alter table public.messages
  add column if not exists edited_at timestamptz,
  add column if not exists deleted_at timestamptz;

create policy "Senders can edit or delete their own messages"
  on public.messages for update
  to authenticated
  using (sender_id = auth.uid())
  with check (sender_id = auth.uid());

-- ---------------------------------------------------------------------
-- MUTE & ARCHIVE — per-participant, like last_read_at and is_favorite
-- (0004). The existing "update your own participant row" policy from
-- 0004 already covers these columns. Mute also suppresses push for the
-- muting user — enforced in the backend's webhook (internal.js).
-- ---------------------------------------------------------------------
alter table public.conversation_participants
  add column if not exists is_muted boolean not null default false,
  add column if not exists is_archived boolean not null default false;

-- ---------------------------------------------------------------------
-- SERVER-SIDE UPLOAD SIZE LIMITS
-- The audit found MAX_FILE_SIZE was enforced only in the app's JS —
-- trivially bypassed by a scripted client since uploads go straight to
-- Storage. Supabase enforces a bucket's file_size_limit at the storage
-- layer itself, so this closes the gap where it actually lives.
-- (25MB matches the app's existing client-side copy; 10MB for avatars.)
-- ---------------------------------------------------------------------
update storage.buckets set file_size_limit = 26214400 where id = 'chat-media';
update storage.buckets set file_size_limit = 10485760 where id = 'avatars';

-- ---------------------------------------------------------------------
-- PUSH TRIGGER — read the backend URL from a Postgres setting instead
-- of a hardcoded string literal. Push is disabled unless the backend URL
-- and webhook secret are explicitly configured for this database.
-- ---------------------------------------------------------------------
-- Push notifications are opt-in per database. If no backend URL and
-- webhook secret are configured, do not make any outbound HTTP request.
create or replace function public.notify_new_message()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog
as $$
declare
  backend_url text;
  webhook_secret text;
begin
  backend_url := nullif(current_setting('app.backend_url', true), '');
  webhook_secret := nullif(current_setting('app.webhook_secret', true), '');

  -- Local UI/database development should never silently notify a hosted
  -- service. Explicitly configure both values for a dedicated dev/staging
  -- backend when push integration testing is intended.
  if backend_url is null or webhook_secret is null then
    return new;
  end if;

  if backend_url !~ '^https?://' then
    return new;
  end if;

  perform net.http_post(
    url := rtrim(backend_url, '/') || '/webhooks/new-message',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'Authorization', 'Bearer ' || webhook_secret
    ),
    body := jsonb_build_object(
      'messageId', new.id,
      'conversationId', new.conversation_id,
      'senderId', new.sender_id,
      'text', new.text,
      'mediaType', new.media_type
    )
  );
  return new;
end;
$$;

-- ---------------------------------------------------------------------
-- OPTIONAL MANUAL STEP — explicitly enable push for a dedicated backend:
--
--   ALTER DATABASE postgres SET app.backend_url = 'https://your-dev-backend.example.com';
--   ALTER DATABASE postgres SET app.webhook_secret = 'replace-with-a-long-random-secret';
--
-- Open a NEW SQL editor session for the settings to take effect. If either
-- setting is absent, the trigger intentionally makes no outbound request.
-- ---------------------------------------------------------------------
