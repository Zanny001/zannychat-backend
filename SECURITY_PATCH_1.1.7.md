# ZannyChat backend 1.1.7 — private chat media

## Security change

Migration `0009_private_chat_media.sql` switches the `chat-media` bucket from public to private, removes the public-read policy, and permits authenticated reads only when the caller participates in the conversation named by the first object-path segment. It rewrites known legacy public URLs stored in `messages.media_url` to internal `storage://chat-media/...` markers for frontend signed-URL resolution. Avatar bucket remains public.

## Important rollout requirement

This migration is intentionally coordinated with frontend 1.1.1. Older clients that store/render public URLs are not compatible with a private bucket. Deploy a compatible frontend first or use a controlled maintenance window, then apply migration 0009. New uploads must keep storing object paths/markers, not signed URLs, because signed URLs expire.

## Validation

Static review only. A real Supabase project must verify: participants can create signed URLs and download their attachments; nonparticipants and anonymous users cannot; upload/delete policies remain correctly scoped; old public URL rows are converted. No production migration was run.
