# ZannyChat Backend 1.2.239 — Controlled Production Deployment

## 1. Release scope

This release contains backend security, privacy, messaging and reliability improvements. It builds on the existing 1.2.237/1.2.238 application work.

Source release:
- Backend package version: 1.2.239
- Database migrations introduced in this release: 0065–0073
- Scheduled background workers: scheduled-message delivery, message attachment cleanup and call-invitation notifications
- Node.js runtime configured in GitHub Actions: Node 22

This document describes the source implementation and a controlled rollout procedure. It does not claim that production has been updated.

## 2. Database migration inventory

Review every migration against the actual production schema and migration ledger before applying anything.

| Migration | Purpose |
|---|---|
| 0065 | Per-viewer message hiding and author-controlled global message retraction |
| 0066 | Profile username/details privacy, public profile-details projection, attachment-cleanup queue, durable call-invitation notification queue and call-recipient privacy enforcement |
| 0067 | Hardens global message retraction by scrubbing additional message payload and attachment/contact metadata |
| 0068 | Binds attachment-cleanup candidates to their originating conversation |
| 0069 | Introduces privacy-aware contact-directory projection |
| 0070 | Adds presence-session handling and privacy-filtered presence/read-receipt projections |
| 0071 | Stages private-avatar compatibility with new avatar paths and storage policies while preserving existing public avatars |
| 0072 | Updates the attachment-cleanup claim function to return the conversation binding required by the worker |
| 0073 | Adds private profile-cover paths and an authorization-checked signed-cover lookup while preserving legacy public cover compatibility |

These migrations are intended to preserve existing application data. Nevertheless, inspect their complete SQL, dependencies, grants, policies and effects against the live schema before approval.

### Critical call-table privilege gate

Migration 0059 in this working tree now explicitly declares least-privilege table grants:

- `authenticated`: SELECT, INSERT and UPDATE on `call_sessions`; SELECT and INSERT on `call_signals`.
- `anon`: no table privileges on either call table.
- `service_role`: full table privileges on both call tables.
- Authenticated DELETE on either table is not granted.

A dedicated regression test checks these grant and revoke statements.

A read-only query against the linked production Supabase project verified that the effective table privileges currently match this intended access model. This verifies present permissions, not which migration or manual operation established them.

The linked production project **does contain** `supabase_migrations.schema_migrations`. A read-only inspection on 2026-11-10 confirmed that the table has both legacy version rows (0059, 0065, 0067, 0069, 0075) and timestamped rows through 20261110202504. This is a partial ledger, not a complete, independently verified record of every repository migration.

Comparing the active repository migration directory with the remote ledger snapshot shows that the ledger has no entries for the historical local versions 0001–0058 (except 0059), nor for 0060–0064. The timestamped migrations 20261110192943, 20261110192957, 20261110193010, 20261110193028, 20261110193050 and 20261110193055 are recorded for the corresponding 0066, 0068 and 0070–0073 changes. The older 0066, 0068 and 0070–0073 filenames have therefore been moved out of the active migration directory and preserved under supabase/migration-archive/legacy so they cannot be replayed as new versions. Read-only checks confirmed several corresponding database objects already exist (including phone-discovery objects, the call heartbeat/lease column and RPC, the status-expiry trigger/constraint, and the public-schema CREATE revocations). This establishes current schema state for those objects, but does not prove the exact source migration/version that created them.

Several historical rows (including 0059, 0065, 0067, 0069 and 20261110170000) have no recorded statement array or creator metadata. Their presence proves that those version labels are recorded, but does not independently prove that the recorded SQL exactly matches the repository file. Timestamped replacement migrations for 0065–0073 are recorded separately. The 0071 timestamped source is the corrected variant; the old legacy 0071 file used a different parameter name and a less restrictive function search path and must not be replayed.

Therefore:
1. Preserve the verified live call-table privileges and current durable-call-history behavior.
2. Keep the exact, corrected timestamped migration sources that correspond to the recorded timestamped versions.
3. Treat local versions 0001–0058 (except 0059) and 0060–0064 as unrecorded in the remote ledger. Read-only checks show key objects from some of those versions are present, but their exact source migration provenance remains unverified.
4. Do not run `supabase db push`, `--include-all`, migration repair, or a reset against production until a reviewed baseline accounts for every pending local version and every remote ledger row.
5. Do not insert/delete ledger rows merely to make local and remote histories appear aligned.

### Migration history and production safety

1. Take or verify a recoverable Supabase backup/PITR restore point before any approved schema rollout.
2. Establish a supported, authoritative application migration-history baseline. The `supabase_migrations.schema_migrations` ledger exists, but its recorded versions do not cover the full local historical migration chain.
3. Do not mistake `auth.schema_migrations`, `realtime.schema_migrations` or `storage.migrations` for the application's migration ledger.
4. Reconcile repository migrations 0001–0073 against the actual production schema and any independently retained deployment records.
5. Review the complete SQL for migrations 0065–0073, including dependencies, grants, policies and effects against the live schema.
6. Do not run migration repair, `--include-all`, `db reset` or `db push` until a reviewed reconciliation plan establishes the correct baseline.
7. Obtain explicit production approval before applying any migration.
8. Verify database objects, effective privileges and the authoritative migration history after an approved rollout.

Two narrow, non-data-changing migrations were applied during this review:

- `20261110202304_harden_qualified_definer_search_paths_0063`: pins existing reviewed SECURITY DEFINER functions to an empty `search_path` and safely skips the absent `get_conversation_poll_vote_counts(uuid)` overload. Post-apply inspection confirmed `set_pinned_message_snapshot()` and `deliver_due_scheduled_messages(integer)` now have an empty `search_path`.
- `20261110202504_index_remaining_call_foreign_keys_and_optimize_profile_rls`: adds indexes for the caller/callee foreign keys on `call_invitation_notifications` and the host foreign key on `group_call_rooms`, and changes the owner-only `profile_details` policy to use `(SELECT auth.uid())` without changing its access semantics.

Post-apply Supabase performance-advisor results no longer report unindexed foreign keys or the profile RLS init-plan warning. The remaining 80 unused-index notices are informational; do not drop indexes until real production workload confirms they are unnecessary. The security advisor still reports 28 RLS-enabled tables without policies; direct privilege inspection confirmed that none of those tables grants SELECT/INSERT/UPDATE/DELETE to `anon` or `authenticated`, which is the intended backend-only design. It also reports 22 authenticated-callable SECURITY DEFINER RPCs that need per-function authorization review (do not blanket-revoke user-facing RPCs) and leaked-password protection disabled in Auth, which remains a separate dashboard/configuration action. No application rows were modified, and no backend deployment, Render configuration change, or APK rebuild was performed.

## 3. Background workers

The scheduled GitHub Actions workflow runs every five minutes and also supports manual dispatch.

It runs three independent commands after successful dependency installation:

- `npm run jobs:scheduled-messages`
- `npm run jobs:attachment-cleanup`
- `npm run jobs:call-notifications`

The workflow uses Node.js 22 and requires these GitHub repository Actions secrets:

- `SUPABASE_URL`
- `SUPABASE_SERVICE_ROLE_KEY`

Configure the secrets through GitHub repository settings. Never print, commit or expose their values.

Before enabling the schedule:
1. Confirm the migrations required by each worker have been approved and applied.
2. Verify the repository secrets are configured.
3. Review worker logs and failure behavior.
4. Confirm that repeated executions are safe and that queue claiming and retry behavior work as intended.
5. Run controlled tests against a non-production environment first.

Do not manually execute production workers until their database prerequisites and operational impact have been reviewed.

### Attachment cleanup limitation

The attachment-cleanup worker validates object paths, checks conversation binding and checks whether message rows still reference an object before requesting Storage deletion.

However, its global paginated reference scan is not a database snapshot. A concurrent message reference can be created or changed after the scan and before Storage deletion. Deterministic pagination does not eliminate that race.

Therefore:
- Do not describe this implementation as providing absolute race-free deletion safety.
- Do not claim cryptographic erasure or guaranteed physical erasure.
- Monitor cleanup results and failures.
- Consider a future database-side atomic reference check/claim or locking design before treating the race as fully resolved.

Legacy cleanup queue entries without a trustworthy conversation binding are expected to be skipped safely.

## 4. Profile privacy and avatar compatibility

Migration 0069 moves contact discovery onto a privacy-aware server projection.

Migration 0070 provides privacy-filtered presence and read-receipt projections while preserving existing participant data.

Migration 0071 is a compatibility stage, not a completed private-avatar cutover:
- Existing public avatar URLs and objects are preserved.
- Existing avatar bucket visibility is not changed by this stage.
- Existing avatar URLs are not rewritten.
- New private avatar paths and access policies are introduced for a controlled transition.

Do not claim that all existing avatars are private until the remaining client migration, signed-URL validation and storage rollout have been completed.

Migration 0073 adds private profile-cover path support and an authorization-checked signed-cover lookup. It does not revoke or delete legacy public cover objects or URLs; do not describe this as a complete legacy-cover privacy cutover.

## 5. Application deployment

### Backend
Deploy the reviewed backend source to the existing Render service only after:
- Code review is complete.
- Required production migrations are approved and applied.
- Render environment variables are verified without exposing their values.
- Worker scheduling and operational ownership are confirmed.

### Frontend
Deploy the matching reviewed frontend source to the existing Netlify site only after compatibility testing against the backend.

Native Android/iOS releases require their own approved build and distribution process where applicable. A web deployment does not update already-installed native applications.

### Authentication and calls
Verify:
- Email and Google authentication.
- OAuth redirect allow-lists and platform-specific client configuration.
- Call signaling, recipient privacy and background invitation behavior.
- TURN configuration and real audio/video connectivity across different networks.

STUN-only operation is not a production guarantee for reliable connectivity.

## 6. Post-deployment verification

After an explicitly approved rollout, verify:

1. Email and Google sign-in on web and supported native clients.
2. Existing conversations and message relationship queries.
3. Text and media delivery across separate accounts.
4. Delivery/read receipts and offline retry.
5. Per-viewer message hiding.
6. Author-only global retraction and complete removal of sensitive message payload fields.
7. Attachment cleanup queue behavior, shared-reference protection and worker failures.
8. Username validation and profile-details privacy.
9. Contact-directory visibility and blocked-user behavior.
10. Presence and read-receipt privacy settings.
11. Existing and staged avatar compatibility.
12. Incoming call notifications when the receiving app is backgrounded or closed.
13. Audio/video call behavior across different networks.
14. Scheduled workflow execution and all three worker logs.
15. Render logs, Netlify deployment status, Supabase Auth logs, RLS policies and Storage policies.

## 7. Automated test status

The source workspace has passed:
- 5 Jest suites: 73 tests.
- 84 Node.js test files: 254 tests.
- Total: 89 test files and 327 passing tests, with zero test failures.

These are automated source-level regression results. They are not a substitute for production migration validation, live HTTP checks, OAuth verification, Storage verification or two-device end-to-end testing.

## 8. Production verification status

Production deployment, database migration application, worker execution and live end-to-end verification have not been established by this document.

Treat all such activities as pending until independently verified after explicit approval.

Do not interpret a passing local test suite, successful source build or deployment configuration as proof that production has been updated.
