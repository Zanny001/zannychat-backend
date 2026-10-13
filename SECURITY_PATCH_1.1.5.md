# ZannyChat backend security patch — 1.1.5 candidate

## Compatibility fix
- Preserves the frontend reaction replacement flow, which uses `upsert({ message_id, user_id, emoji })`, while limiting authenticated UPDATE privileges to those supplied columns.
- Keeps `id` and `created_at` non-updatable and uses `prevent_reaction_identity_change()` to reject changes to reaction identity fields during conflict updates.
- Extends the database verification script to assert the reaction-upsert privileges and protected columns.
- Corrects the README's migration step numbering and clarifies when to run the migration verification script.

## Carried-forward protections
- Pinned-IP link-preview requests with per-hop redirect validation and an absolute five-second deadline.
- Participant and message column-level update restrictions.
- Membership-aware message update policy and reaction update policy.

## Validation performed in this workspace
- `node --check` passed for every JavaScript file under `src/` and `tests/`.
- Static SQL consistency checks passed for the reaction-upsert grants, identity trigger, and matching verification assertions.
- ZIP integrity and packaged migration content were verified.
- Full Jest tests were not run because dependencies are not installed (`express` is unavailable in this workspace); the earlier dependency-install attempt timed out.
- No PostgreSQL/Supabase instance was available, so migrations and RLS behavior have not been executed against a database.
- No deployment was performed.

## Required release gates
1. In a network-enabled environment, install dependencies and run `npm test`.
2. Apply migrations 0001–0007 to a disposable Supabase project and run `supabase/tests/0007_row_mutation_hardening.sql`.
3. Test reaction insertion and emoji replacement through the exact frontend upsert, and verify attempts to change reaction `message_id` or `user_id` fail.
4. Test message edits/deletes, participant read receipts and flags, cross-conversation isolation, and link-preview redirect/DNS/body timeout behavior.
5. Keep production unchanged until the gates pass.
