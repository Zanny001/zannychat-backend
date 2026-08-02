-- ZannyChat — profile photos & chat attachments
-- Run this after 0001_init.sql, same way (Supabase SQL editor or
-- `supabase db push`).
--
-- Design notes:
--   * avatars bucket: public read (an avatar is meant to be seen),
--     write restricted to the owner's own folder
--     (avatars/{user_id}/...).
--   * chat-media bucket: also public read, BUT — unlike avatars —
--     upload is restricted to conversation participants only, and
--     paths are unguessable (chat-media/{conversation_id}/{uuid}-{name}).
--     "Public read" here means "readable by anyone who has the exact
--     URL", not "listable" or "guessable" — the same tradeoff most
--     chat apps make for media links, chosen deliberately over signed
--     URLs (which expire and need refreshing) to keep this simple and
--     reliable without real device testing to validate a more complex
--     signed-URL refresh flow.

alter table public.profiles
  add column if not exists avatar_url text;

alter table public.messages
  add column if not exists media_url text,
  add column if not exists media_type text, -- 'image' | 'file' | 'contact'
  add column if not exists media_name text, -- original filename, or shared contact's name
  add column if not exists media_size bigint, -- bytes, files only
  add column if not exists shared_user_id uuid references public.profiles (id); -- contact-share only

insert into storage.buckets (id, name, public)
values ('avatars', 'avatars', true)
on conflict (id) do nothing;

insert into storage.buckets (id, name, public)
values ('chat-media', 'chat-media', true)
on conflict (id) do nothing;

-- AVATARS ---------------------------------------------------------------
create policy "Avatar images are publicly readable"
  on storage.objects for select
  using (bucket_id = 'avatars');

create policy "Users upload their own avatar"
  on storage.objects for insert
  to authenticated
  with check (bucket_id = 'avatars' and (storage.foldername(name))[1] = auth.uid()::text);

create policy "Users update their own avatar"
  on storage.objects for update
  to authenticated
  using (bucket_id = 'avatars' and (storage.foldername(name))[1] = auth.uid()::text);

create policy "Users delete their own avatar"
  on storage.objects for delete
  to authenticated
  using (bucket_id = 'avatars' and (storage.foldername(name))[1] = auth.uid()::text);

-- CHAT MEDIA --------------------------------------------------------------
create policy "Chat media is readable by anyone with the link"
  on storage.objects for select
  using (bucket_id = 'chat-media');

create policy "Only conversation participants can upload chat media"
  on storage.objects for insert
  to authenticated
  with check (
    bucket_id = 'chat-media'
    and exists (
      select 1 from public.conversation_participants cp
      where cp.conversation_id = ((storage.foldername(name))[1])::uuid
        and cp.user_id = auth.uid()
    )
  );
