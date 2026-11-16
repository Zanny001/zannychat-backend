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
