# ZannyChat backend security patch — 1.1.4 candidate

## New database hardening migration
`supabase/migrations/0007_lock_down_row_mutations.sql` closes an important RLS/column-mutation gap:
- `conversation_participants` updates are limited to `last_read_at`, `is_favorite`, `is_muted`, and `is_archived`; users cannot rewrite `conversation_id`, `user_id`, or `joined_at` to alter membership.
- `messages` updates are limited to `text`, `edited_at`, and `deleted_at`; message identity, author, conversation, reply target, and creation time are immutable to authenticated clients.
- Message update RLS now also verifies conversation membership.
- Reaction update RLS requires current conversation membership. Narrow column grants preserve the frontend's `upsert(message_id, user_id, emoji)` path, while a trigger prevents changing reaction identity fields; `id` and `created_at` remain non-updatable.

## Included link-preview hardening
This release also carries forward the 1.1.3 candidate's pinned-IP SSRF defense, per-hop redirect validation, IPv4/IPv6 filtering, and absolute five-second request deadline.

## Validation performed in this workspace
- `node --check` passed for every JavaScript file under `src/` and `tests/`.
- Standalone smoke checks passed for IPv4/IPv6 destination filtering and absolute-deadline behavior.
- Reviewed the existing frontend reaction upsert and added a SQL privilege assertion to protect that path; this assertion still needs execution against PostgreSQL.
- The full Jest suite could not be run because dependency installation timed out.
- No PostgreSQL/Supabase instance was available, so migration 0007 and its verification script (`supabase/tests/0007_row_mutation_hardening.sql`) have not been executed against a database; run them against a disposable Supabase project before production.
- No deployment was performed.

## Before deployment
1. Install dependencies in a network-enabled environment and run `npm test`.
2. Apply migrations 0001–0007 to a disposable Supabase project, run `supabase/tests/0007_row_mutation_hardening.sql`, and test RLS as at least two authenticated users plus anon.
3. Specifically verify that changing `conversation_participants.conversation_id`, changing message identity columns, or moving a reaction to another message is denied, while read receipts, favorite/mute/archive flags, message edit/delete, and reaction emoji replacement via the frontend's upsert all still work.
4. Run HTTP/HTTPS link-preview integration tests for pinned DNS, redirects, slow DNS/body behavior, and IPv4/IPv6 destinations.
5. Keep the live service unchanged until these release gates pass.
