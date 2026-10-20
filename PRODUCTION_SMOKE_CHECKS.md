# Production smoke checks

The backend exposes three public operational endpoints:

- `GET /` — service discovery, no secrets.
- `GET /health/live` — process liveness; intentionally does not require Supabase.
- `GET /health/ready` — strict readiness; returns HTTP 503 if the service cannot reach Supabase.
- `GET /health/` — legacy diagnostic endpoint retained for existing platform monitors.

After deploying the backend changes, run `node scripts/smoke-production.mjs` from the backend directory. It only makes public GET requests; it does not sign in, write data, or require credentials. Configure `ZANNYCHAT_FRONTEND_URL` and `ZANNYCHAT_BACKEND_URL` to test staging or alternate deployments.

**Release gate:** do not route production traffic to a revision unless the frontend and backend root/liveness checks pass and readiness confirms `supabaseReachable: true`. The smoke script will intentionally fail while Render is unavailable or Supabase is unreachable. It cannot verify authenticated flows, RLS, push notifications, realtime delivery, media permissions, or physical-device behavior; those require separate staging tests.
