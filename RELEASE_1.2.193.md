# Release 1.2.193

- Poll results now use a membership-checked PostgreSQL aggregate instead of transferring every raw vote and voter ID to each client.
- Vote counts are aggregated in SQL and converted to safe non-negative integer counts in the frontend.
- Added migration `0051_poll_vote_count_aggregation.sql`; apply it before deploying frontend 1.2.193.
- Added focused utility and migration regression tests.

## Verification limits
The migration has static regression coverage but was not executed against a live Supabase database. This release has not been deployed to production.
