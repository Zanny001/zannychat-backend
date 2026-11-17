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
- Frontend: https://zannychat.netlify.app (site remains live; production deploys are currently paused by Netlify credit limits)
- Backend: https://zannychat-backend-1.onrender.com
- Supabase project URL: https://vithpppgyjmazxvogvno.supabase.co

The smoke script defaults to these frontend/backend hosts. Override with `ZANNYCHAT_FRONTEND_URL` and `ZANNYCHAT_BACKEND_URL` for staging.


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
