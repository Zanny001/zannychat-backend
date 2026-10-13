# ZannyChat coordinated private-media release 1.2.0 candidate

Contents:
- `zannychat-backend/` — backend 1.1.7, migrations 0001–0009, row-security verification scripts, and new read-only private-media migration audit.
- `zannychat-frontend/` — compatible frontend 1.1.2 with private media markers and signed-URL resolution.

The new audit is under `zannychat-backend/supabase/diagnostics/private_media_migration_audit.sql`. It reports unresolved legacy public URLs, path/conversation mismatches, and malformed markers for administrator review; it makes no changes.

This remains a release candidate. Static syntax and archive checks do not substitute for PostgreSQL/Supabase RLS integration tests, the complete Jest suite, or a production frontend build. Do not deploy until those gates pass.
