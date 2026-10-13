-- ZannyChat — group chats, voice notes, and push notifications
-- Run after 0001 and 0002, same way (Supabase SQL editor or
-- `supabase db push`).
--
-- This one has a manual step beyond just running the SQL — see the
-- bottom of this file for the ALTER DATABASE command needed to set
-- the webhook secret. Skipping it means push notifications silently
-- never fire (the trigger runs, the backend rejects the unauthenticated
-- request, nothing crashes) — annoying to debug, so it's called out
-- clearly here rather than left to be discovered later.

-- ---------------------------------------------------------------------
-- GROUP CHATS
-- A conversation with a non-null `name` is a group; null name means
-- "derive the display name from the other 1:1 participant," which is
-- what the frontend already does. No admin/kick/promote concept here —
-- any participant can post, same as everyone else. That's a real
-- limitation, not an oversight: it keeps this addition small enough to
-- reason about without live testing.
-- ---------------------------------------------------------------------
alter table public.conversations
  add column if not exists name text,
  add column if not exists is_group boolean not null default false;

-- ---------------------------------------------------------------------
-- VOICE NOTES
-- Reuses the media_url/media_type columns from 0002 (media_type =
-- 'voice') — this just adds duration, which a voice bubble needs to
-- show upfront without loading the audio first.
-- ---------------------------------------------------------------------
alter table public.messages
  add column if not exists media_duration integer; -- seconds

-- ---------------------------------------------------------------------
-- PUSH NOTIFICATIONS
-- One row per device (a user signed in on two phones gets two rows).
-- Token churns (reinstalls, app resets) so this is upserted by the
-- frontend on every login, not written once.
-- ---------------------------------------------------------------------
create table if not exists public.push_tokens (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles (id) on delete cascade,
  expo_push_token text not null unique,
  platform text, -- 'ios' | 'android'
  updated_at timestamptz not null default now()
);

alter table public.push_tokens enable row level security;

create policy "Users manage their own push tokens"
  on public.push_tokens for all
  to authenticated
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

-- ---------------------------------------------------------------------
-- THE TRIGGER — optionally posts to the configured backend's
-- /webhooks/new-message on message inserts. pg_net's http_post is async and fire-and-forget from
-- Postgres's side (it queues the request and returns immediately), so
-- a slow or failing backend can never block someone's message from
-- sending — the worst case of this trigger misbehaving is a missed
-- notification, never a broken chat.
-- ---------------------------------------------------------------------
create extension if not exists pg_net;

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

drop trigger if exists on_message_created on public.messages;
create trigger on_message_created
  after insert on public.messages
  for each row execute procedure public.notify_new_message();

-- ---------------------------------------------------------------------
-- OPTIONAL — only if you want to enable push notifications, run this
-- command separately, with your own random value instead of the placeholder.
-- This is deliberately NOT a literal secret baked into this file — current_setting() reads it at
-- call time, so the actual value never ends up committed anywhere.
-- Generate one with `openssl rand -hex 32` or similar, then set the
-- SAME value as INTERNAL_WEBHOOK_SECRET in the backend's Render env
-- vars (see render.yaml) — both sides have to agree on it.
--
--   ALTER DATABASE postgres SET app.webhook_secret = 'replace-this-with-a-real-random-value';
-- Also configure app.backend_url before push is enabled; otherwise the trigger is a no-op.
--
-- Run that in the SQL editor too, then start a NEW SQL editor query
-- (settings changed by ALTER DATABASE apply to new sessions, not the
-- one that ran the command).
-- ---------------------------------------------------------------------
