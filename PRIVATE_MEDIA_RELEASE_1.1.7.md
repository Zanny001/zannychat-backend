# ZannyChat private-media coordinated release

This release pairs **backend 1.1.7** with **frontend 1.1.2**. It privatizes chat attachments; it is not a backend-only upgrade.

## Required rollout

1. Back up the database and confirm migrations 0001–0008 are applied.
2. Build and distribute the compatible frontend 1.1.2 before privatizing the bucket, or use a controlled maintenance window so no older clients continue using public URLs.
3. Apply `zannychat-backend/supabase/migrations/0009_private_chat_media.sql`. It converts known stored public URLs to storage markers, marks `chat-media` private, removes the public-read policy, and adds participant-scoped reads.
4. Run `zannychat-backend/supabase/tests/0009_private_chat_media.sql` as database owner, then test actual signed URL creation/downloads with two conversation members, a nonmember, and an anonymous client.
5. Confirm avatars remain public and that image, file, and voice attachments work on iOS/Android/web.

## Limitations and safety notes

- These archives were statically checked and ZIP integrity was verified. Jest could not run because the environment has no installed Jest executable; no live Supabase/Postgres or device test has been run.
- Existing public URLs already copied outside the app cannot be revoked from people who have downloaded the files.
- Signed URLs are bearer links until they expire (configured for 24 hours in the frontend). Do not store signed URLs in message rows; store object paths/markers instead.
- If a signing request fails, the UI receives a message with `mediaUrl: null` rather than failing to load all text history.
- No production migration or deployment was performed.


## Follow-up patch 1.1.8

The coordinated frontend is version 1.1.2. It now requires legacy Storage URLs to match the configured Supabase project origin and validates relative object paths before requesting a signed URL. See `PRIVATE_MEDIA_RELEASE_1.1.8.md`.
