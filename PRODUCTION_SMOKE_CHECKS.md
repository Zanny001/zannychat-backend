# Production smoke checks

The backend exposes three public operational endpoints:

- `GET /` — service discovery, no secrets.
- `GET /health/live` — process liveness; intentionally does not require Supabase.
- `GET /health/ready` — strict readiness; returns HTTP 503 if the service cannot reach Supabase.
- `GET /health/` — legacy diagnostic endpoint retained for existing platform monitors.

After deploying the backend changes, run `node scripts/smoke-production.mjs` from the backend directory. It only makes public GET requests; it does not sign in, write data, or require credentials. Configure `ZANNYCHAT_FRONTEND_URL` and `ZANNYCHAT_BACKEND_URL` to test staging or alternate deployments.

For authenticated Realtime acceptance, use two test accounts in one shared conversation: verify message inserts, participant read-cursor updates, message delivery receipts, and message reaction insert/update/delete events arrive only for authorized conversation members. The catalog check below is necessary but does not prove delivery.

**Release gate:** do not route production traffic to a revision unless the frontend and backend root/liveness checks pass and readiness confirms `supabaseReachable: true`. The smoke script will intentionally fail while Render is unavailable or Supabase is unreachable. It cannot verify authenticated flows, RLS, push notifications, realtime delivery, media permissions, or physical-device behavior; those require separate staging tests.


Current production targets (verified project configuration):
- Frontend: https://zannychat.vercel.app (verified Vercel production domain; confirm the current production deployment in Vercel before release acceptance)
- Backend: https://zannychat-backend-1.onrender.com
- Supabase project URL: https://vithpppgyjmazxvogvno.supabase.co

The smoke script defaults to these canonical frontend/backend hosts. Override with `ZANNYCHAT_FRONTEND_URL` and `ZANNYCHAT_BACKEND_URL` for staging.


## Supabase Realtime publication check

Run the following read-only catalog query after a migration:

```sql
select schemaname, tablename
from pg_publication_tables
where pubname = 'supabase_realtime'
  and schemaname = 'public'
order by tablename;
```

The current production publication should include `call_sessions`, `call_signals`, `conversation_participants`, `conversations`, `message_delivery_receipts`, `message_reactions`, `messages`, and `status_updates`. Do not add a table without first verifying RLS is enabled, authenticated SELECT is appropriately scoped, and anon has no SELECT access. Realtime delivery must still be tested with two accounts; publication membership alone is not a delivery guarantee.


## LIVE creator recovery and end-retry acceptance

Run only against a dedicated staging stream with two authenticated test accounts. Never use a real creator's active broadcast for this test.

1. Account A starts a public LIVE broadcast and confirms the creator receives a connection containing the persisted stream ID, LiveKit URL and creator token.
2. Account B opens the stream as a viewer, confirms subscribe-only media, and verifies comments/reactions work only while joined.
3. Simulate a creator-side network interruption without choosing End LIVE. Restore connectivity and reopen the creator stream from LIVE Hub. The creator profile must identify the same active stream, the join endpoint must return a complete connection, and the creator must regain publish permissions.
3a. After the creator profile refresh, LIVE Hub must replace the create CTA with `Rejoin LIVE` and route directly to the same active stream. If Hub state is stale and Preflight is opened, the client must recognize the specific active-stream 409, fetch the authenticated creator profile and rejoin the same stream ID.
3b. Verify no second active stream row or duplicate Egress session is created.
4. After the creator-reentry migration `20261121043000_live_creator_reentry_bypasses_viewer_cap` is explicitly approved and applied in the target environment, verify that creator re-entry is not rejected when the audience has reached its configured viewer limit. Viewer and guest admission limits must remain enforced.
5. While Account A is connected, use the visible creator header `REC` action (or its accessible `Start LIVE replay recording` label) and confirm the recording consent prompt. Verify the replay enters `recording`, the replay row is persisted, and stopping it (or reaching the five-minute cap) moves it through processing to `ready`; verify a private storage object and authorized signed playback. Replay recording is an explicit creator action, not automatic.
6. End the broadcast as Account A. Verify the end request returns `ended: true`, Account B is disconnected, and the replay/Egress and LiveKit room cleanup complete.
7. Repeat the creator end request to simulate a lost first HTTP response. The retry should return HTTP 200 with `ended: true` and `alreadyEnded: true`, retry Egress/room cleanup, and must not send a second end notification.
8. Verify new viewer joins are rejected after end and the creator profile no longer lists the stream as live.

Evidence requirements:
- Record the staging environment, UTC timestamps, account roles (A/B), HTTP status and response fields, and LiveKit room state.
- Do not record access tokens, API keys, private media URLs or personal message content.
- Source/CI tests do not satisfy this acceptance gate. Do not claim production or physical-device acceptance until the two-account test is actually completed.
- The creator-reentry migration is currently source-controlled but is not yet applied to production Supabase. Do not treat step 4 as production-ready until the exact migration is separately approved and its ledger entry is verified.
