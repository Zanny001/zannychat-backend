# ZannyChat Backend 1.2.58

## Channel moderation report pagination
- Report listing now returns 50 open reports per page, ordered by creation timestamp and ID.
- Added validated cursor pagination and `hasMore` / `nextCursor` response metadata.
- The existing channel owner/moderator authorization check remains required before report access.
- No database migration required.

## Verification
- Backend tests: 191 passed.
- Live Supabase execution and production deployment were not performed.
