# Production Migration Ledger Update — 2026-11-16

## Message insert integrity guard

- **Supabase project:** `vithpppgyjmazxvogvno`
- **Applied migration version:** `20261116195405`
- **Migration name:** `guard_message_insert_integrity`
- **Repository file:** `supabase/migrations/20261116195405_guard_message_insert_integrity.sql`
- **Status:** Applied and verified in production.

The migration installs an invoker-only `BEFORE INSERT` trigger on `public.messages`. It:
- Stamps `created_at` with database time and clears client-supplied `edited_at` and `deleted_at` on INSERT.
- Requires reply targets to belong to the same conversation. Replies to soft-deleted tombstones remain supported.
- Requires new attachment rows to reference an existing `chat-media` object in the same conversation, owned by the message sender, with supported media type and bounded size/duration/name metadata.
- Keeps plain text and shared-contact payloads separate from media attachment metadata.
- Does not alter existing RLS policies, table grants, storage bucket policies, or existing rows.

## Verification evidence

1. Production catalog review found 67 SECURITY DEFINER functions; zero unpinned search paths, zero PUBLIC EXECUTE grants and zero anon EXECUTE grants.
2. Production message data contained 22 distinct conversations and 14 valid attachment/object ownership examples for the new guard.
3. SQL syntax and trigger behavior were exercised inside a transaction that was rolled back.
4. Smoke checks covered server-owned timestamps, cross-conversation reply rejection, a valid existing chat-media object, and forged sender rejection under the authenticated role.
5. Post-rollback verification confirmed the test rows did not persist. After applying the migration, catalog verification confirmed the function exists and exactly one trigger is installed.

## Rollback

The change is additive and does not rewrite existing data. If emergency rollback is required:

```sql
BEGIN;
DROP TRIGGER IF EXISTS guard_message_insert_integrity ON public.messages;
DROP FUNCTION IF EXISTS private.guard_message_insert_integrity();
COMMIT;
```

Any rollback must also be reconciled with the Supabase migration ledger before a subsequent `supabase db push`.

## Operational caveat

This migration was applied after CI passed and after a transaction-only production smoke test. The Supabase integration did not expose a fresh backup-creation action in this session; the migration is non-destructive and has the explicit rollback above. Continue to take scheduled database and storage backups.


## Call signaling rate-limit integrity

- **Applied migration version:** `20261116195939`
- **Migration name:** `guard_call_signal_server_timestamps`
- **Repository file:** `supabase/migrations/20261116195939_guard_call_signal_server_timestamps.sql`
- **Status:** Applied and verified in production.

The existing `public.validate_call_signal_insert()` trigger now stamps `NEW.created_at` after its per-call/sender advisory lock and uses that server timestamp for the 120-signals-per-minute window. This prevents authenticated callers from supplying an old timestamp to bypass the rate limiter. Existing sender, participant, accepted-session, expiry and signal-type checks remain. Direct EXECUTE is revoked from PUBLIC, anon and authenticated; the trigger remains attached to `public.call_signals`.

Verification: migration CI passed; SQL syntax was validated in a rollback-only transaction; production catalog inspection confirmed the new function body, pinned empty search_path, SECURITY DEFINER status and no anon/authenticated EXECUTE. No call-signal rows were inserted or rewritten by the migration.


## User activity and presence timestamp integrity

- **Applied migration version:** `20261116203426`
- **Migration name:** `guard_user_activity_server_timestamps`
- **Repository file:** `supabase/migrations/20261116203426_guard_user_activity_server_timestamps.sql`
- **Status:** Applied and verified in production.

The migration installs 14 narrowly scoped BEFORE INSERT/UPDATE triggers backed by `private.stamp_user_activity_timestamps()`, a SECURITY INVOKER function with an empty pinned search_path and no direct EXECUTE for anon/authenticated. It stamps activity timestamps for blocks, status mutes, reports, status audience/exclusion rows, status views/replies/reactions, message reactions, pinned messages, conversation read cursors, profile activity, push-token updates and presence heartbeats. Explicit NULL read-cursor resets remain possible. Existing profile visibility and pinned-message snapshot triggers are preserved. No RLS policies, table grants, ownership rules or existing rows were changed.

Production verification: Supabase ledger records version `20261116203426`; catalog confirms the function and 14 attached triggers; anon/authenticated direct EXECUTE are both false. DDL was first executed in a rollback-only transaction; migration then applied successfully.

Emergency rollback (reconcile the migration ledger before any subsequent `supabase db push`):

```sql
BEGIN;
DROP TRIGGER IF EXISTS blocked_users_server_timestamp_before_insert ON public.blocked_users;
DROP TRIGGER IF EXISTS muted_status_users_server_timestamp_before_insert ON public.muted_status_users;
DROP TRIGGER IF EXISTS reports_server_timestamp_before_insert ON public.reports;
DROP TRIGGER IF EXISTS status_audience_recipients_server_timestamp_before_insert ON public.status_audience_recipients;
DROP TRIGGER IF EXISTS status_excluded_users_server_timestamp_before_insert ON public.status_excluded_users;
DROP TRIGGER IF EXISTS status_views_server_timestamp_before_insert ON public.status_views;
DROP TRIGGER IF EXISTS status_replies_server_timestamp_before_insert ON public.status_replies;
DROP TRIGGER IF EXISTS message_reactions_server_timestamp_before_insert ON public.message_reactions;
DROP TRIGGER IF EXISTS status_reactions_server_timestamp_before_write ON public.status_reactions;
DROP TRIGGER IF EXISTS pinned_messages_server_timestamp_before_insert ON public.pinned_messages;
DROP TRIGGER IF EXISTS conversation_participants_read_cursor_server_timestamp_before_update ON public.conversation_participants;
DROP TRIGGER IF EXISTS profile_details_activity_server_timestamp_before_write ON public.profile_details;
DROP TRIGGER IF EXISTS push_tokens_server_timestamp_before_write ON public.push_tokens;
DROP TRIGGER IF EXISTS user_presence_sessions_server_timestamp_before_write ON public.user_presence_sessions;
DROP FUNCTION IF EXISTS private.stamp_user_activity_timestamps();
COMMIT;
```


## Activity timestamp dispatcher correction

- **Applied migration version:** `20261116203635`
- **Migration name:** `fix_user_activity_timestamp_dispatch`
- **Repository file:** `supabase/migrations/20261116203635_fix_user_activity_timestamp_dispatch.sql`
- **Status:** Applied and verified in production.

A post-apply review identified that the first shared timestamp function version had attached all 14 triggers but lacked explicit dispatch branches for the insert-only block/mute/report/status-audience/reply/reaction tables. The corrective migration replaces the function body with explicit branches for all 14 attached tables and raises an exception for an unexpected trigger table. Catalog verification after correction confirms all 14 triggers remain attached and anon/authenticated cannot directly execute the function. No data or RLS policy was modified by the correction.
