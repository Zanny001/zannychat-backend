# ZannyChat migration and media/call/LIVE audit — 2026-11-11

## Migration ledger

- The backend repository's `main` branch contained 108 SQL migration files at audit time.
- Supabase's remote migration ledger contained 46 applied entries after applying `20261111123440_fix_status_media_upload_rls`.
- The repository branch for this fix contains 109 migration files; 63 repository migration versions are not represented in the remote ledger.

The missing ledger entries include the original baseline migrations (`0001` onward). The live database already contains the relevant status, call, and LIVE tables and their RLS policies, so an absent ledger row must **not** be treated as proof that the migration's DDL is absent. Do not blindly replay the missing migrations. Reconcile the baseline history only after comparing each migration's effects with the live schema and data.

## Status media

- Supabase Storage logs recorded an INSERT rejection (SQLSTATE `42501`) for a valid upload to the private `status-media` bucket.
- The prior upload policy required `storage.objects.metadata.size` to be present during the INSERT RLS check. Storage does not guarantee that metadata field is populated at that point.
- Migration `20261111123440_fix_status_media_upload_rls` removes only that brittle metadata prerequisite. It retains authenticated owner checks, the matching active `status_updates` row, exact object path, expiry, media-kind and extension checks.
- Verified after application: `status-media` remains private, allows JPEG/PNG/WebP/MP4, and enforces a 50 MiB bucket maximum. The upload policy no longer references object metadata.

## Calls

- `call_sessions` and `call_signals` are present in the `supabase_realtime` publication.
- Both tables have authenticated participant-scoped RLS policies.
- The browser app previously skipped the incoming-call Realtime listener entirely. The frontend fix enables that listener on web, backfills still-ringing invitations after login, and routes recipients to the existing Answer/Decline screen.
- At audit time, the durable call-notification queue had seven expired entries, while both `push_tokens` and `call_voip_tokens` had zero rows. Background native push cannot be delivered until a physical native device registers a push token. Browser notifications are now permission-gated and require the ZannyChat tab to remain open/running; closed-browser Web Push is not configured by this change.

## LIVE

- The live-stream tables exist with RLS enabled and no client SELECT privileges; the checked call/LIVE internal tables are service-role-only.
- No `live_streams` rows existed at audit time, so the attempted Go LIVE flow had not successfully created a server-side stream.
- The backend requires `LIVEKIT_URL`, `LIVEKIT_API_KEY`, and `LIVEKIT_API_SECRET`. The frontend now displays an actionable error if the server reports missing configuration or returns an incomplete room connection.
- Render environment values were not inspected or changed as part of this GitHub/Supabase-authorized work.

## Security-linter interpretation

Supabase reported RLS-enabled tables with no policies. For the checked call-notification, VoIP-token, and LIVE internal tables, direct SELECT privileges are revoked from `anon` and `authenticated` and retained for `service_role`. These are intentionally server-only tables; do not add broad client policies merely to silence the informational lint.
