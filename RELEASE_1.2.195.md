# ZannyChat Release 1.2.195 — bounded poll history and scoped vote aggregation

## Changes
- Added `listConversationPollPage` with bounded page sizes (1–100), stable descending ordering by creation timestamp and ID, look-ahead pagination, and explicit `hasMore`/`nextOffset` metadata.
- Updated the Polls screen to fetch 40 polls initially and expose a Load older polls action. Loading older items deduplicates IDs before appending.
- Added migration `0052_poll_vote_counts_scoped_to_page.sql`, which aggregates vote counts only for the requested poll page rather than every poll in the conversation.
- The new RPC requires an authenticated conversation member, bounds the requested poll IDs to 1–100, validates that every poll belongs to the requested conversation, and revokes execution from `public` and `anon`.
- Kept the existing `listConversationPolls` convenience export for compatibility; it returns at most 100 polls. Use `listConversationPollPage` for paginated history.
- Updated frontend version manifests to 1.2.195 and backend package version to 1.2.49.

## Verification
- Frontend unit tests: 340 passed, 0 failed.
- Backend regression tests: 173 passed, 0 failed.
- Frontend release audit: 12/12 passed.
- Version manifests and ZIP integrity checked after packaging.

## Deployment notes
Apply migration `0052_poll_vote_counts_scoped_to_page.sql` before deploying this frontend. The migration was tested by static/source regression tests only; no live Supabase execution, production build, device testing, staging integration, or deployment was performed in this pass.
