# Backend 1.2.47 — unique migration versioning

- Renamed the channel post idempotency migration from version `0046` to `0048` to eliminate a duplicate migration version with the server-enforced Status expiry migration.
- Added `tests/migrationVersionUniqueness.test.cjs` to enforce numeric, unique SQL migration prefixes.
- Updated the channel post idempotency migration test path.

Validation should include the migration uniqueness test and channel idempotency regression tests. This release does not apply any migration to production. Before deploying, compare migration history in the target Supabase project: if the old `0046_channel_post_idempotency.sql` was already applied, reconcile the recorded migration version carefully rather than blindly applying the renamed file.
