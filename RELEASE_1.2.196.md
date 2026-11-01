# ZannyChat Release 1.2.196 — stable keyset pagination for poll history

## Changes
- Poll history now supports keyset pagination using the last visible poll's `(created_at, id)` tuple, preventing new polls created during browsing from shifting offset-based pages and causing older polls to be skipped or duplicated.
- Cursor input is validated for a parseable timestamp and UUID-shaped poll ID before it is interpolated into the Supabase filter.
- The cursor is derived from the last visible row, not the look-ahead row. Bounded page sizes, deterministic descending ordering, scoped vote-count aggregation, and deduplication remain in place.
- Legacy offset paging remains supported for callers that explicitly pass an offset. Existing poll creation and voting APIs are unchanged.
- Frontend version: 1.2.196. Backend package and lockfile version: 1.2.50. No database migration is required for this frontend pagination improvement.

## Verification
- Frontend unit tests: 341 passed, 0 failed.
- Backend regression tests: 173 passed, 0 failed.
- Frontend release audit: 12/12 passed.
- Frontend and backend version manifests checked for consistency.
- ZIP integrity checked after packaging.

## Deployment notes
No new migration is required for this change. This release has not been deployed to production; test poll history on staging before rollout.
