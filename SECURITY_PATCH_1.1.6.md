# ZannyChat backend security patch — 1.1.6 candidate

## New migration: block-status probe guard
- Restricts `is_blocked_in_conversation()` to checking the authenticated caller's own sender identity and conversations where they are a participant.
- Revokes function execution from `PUBLIC` and `anon`; retains execution for `authenticated` because the messages INSERT RLS policy calls it.
- Adds `supabase/tests/0008_block_status_probe_guard.sql` to check function grants and required guards.

## Carried-forward hardening
- SSRF-resistant link previews with pinned public-IP connections, per-hop redirect checks, IPv4/IPv6 filtering, and an absolute five-second deadline.
- Participant/message column-level update restrictions and reaction-upsert-compatible grants guarded by an immutable-identity trigger.

## Known remaining privacy gap
- The `chat-media` Storage bucket is still configured as public, so anyone holding an exact media URL may be able to read that object. This was an explicitly documented design tradeoff in migration 0002, not something migration 0008 changes.
- Do not switch that bucket to private in this backend-only patch: the current frontend stores public URLs in `messages.media_url` and renders them directly. A safe fix requires a coordinated frontend change to store object paths, create short-lived signed URLs for authorized conversation participants, and support existing stored URLs during migration. Avatar images are separately public by design.

## Validation performed in this workspace
- JavaScript syntax checks passed for all files under `src/` and `tests/`.
- Static SQL consistency checks passed for migrations 0007 and 0008 and their verification scripts.
- ZIP integrity and packaged migration content were verified.
- Full Jest tests remain unrun because dependencies are not installed in this workspace (`express` is unavailable); an earlier dependency-install attempt timed out.
- No PostgreSQL/Supabase instance was available, so the migrations and RLS behavior have not been executed against a database.
- No deployment was performed.

## Required release gates
1. Install dependencies in a network-enabled environment and run `npm test`.
2. Apply migrations 0001–0008 to a disposable Supabase project and run both SQL verification scripts.
3. Test block behavior through the message INSERT policy and verify direct RPC attempts using another sender ID or a conversation the caller does not belong to return `false`.
4. Re-test reaction emoji replacement, participant flags/read receipts, message edit/delete, and cross-conversation isolation.
5. Keep production unchanged until all gates pass.
