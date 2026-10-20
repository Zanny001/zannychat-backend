# Group metadata — backend v1.2.31

Migration `0039_group_metadata.sql` adds `group_topic` (max 80 characters) and `group_description` (max 500 characters) with empty defaults. Authenticated members can read metadata; only admins can update it. API validation and database checks both enforce bounds. Migration is additive and re-runnable.

Local verification: `node --test tests/groupMetadataMigration.test.cjs` and related private-channel/channel regressions pass; `node --check src/routes/conversations.js` passes. Live database, hosted API, multi-account, and physical-device tests remain outstanding.
