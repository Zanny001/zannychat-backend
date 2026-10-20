# Group announcement mode — backend 1.2.34

`GET /conversations/:conversationId/metadata` returns `adminOnlyMessages`. Admin-only `PATCH` accepts optional boolean `adminOnlyMessages`; malformed types are rejected. The database RLS migration `0040_group_announcement_mode.sql` is the authoritative send restriction.

Apply migrations in order and test member/admin sends in staging before production deployment.
