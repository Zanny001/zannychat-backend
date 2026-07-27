# ZannyChat — Backend (Phase 2)

This is the server side of ZannyChat: a Supabase schema plus a small
Express service deployed to Render. It's built to pair directly with
`zannychat-frontend` — table names and columns match what
`src/services/api.js` in the frontend already calls.

## What lives where, and why

Most of the app's day-to-day data — messages, conversations, profiles —
is read and written **directly from the mobile app to Supabase**, using
the anon key and Row Level Security. That's what Supabase Realtime is
for, and it means chat stays fast with nothing routed through this
backend.

This Express service exists specifically for the things that must
**never** run on the client:

- **Payment webhooks** (`/webhooks/stripe`) — only a server can hold a
  webhook signing secret safely.
- **Wallet balance changes** (`/wallet/*`) — the ledger tables have no
  insert policy for the `authenticated` role at all, on purpose. Balances
  can only move through this reviewed server code, never a client call.
- **Multi-step writes** (`/conversations`) — creating a conversation plus
  both participant rows in one trusted call, instead of asking the
  client to do two inserts against RLS.
- A **scheduled reconciliation job**, run independently on Render Cron
  so a slow job never blocks chat traffic.

## 1. Set up Supabase

1. Create a project at [supabase.com](https://supabase.com).
2. Open the SQL editor and run `supabase/migrations/0001_init.sql`
   (or `supabase db push` if you're using the Supabase CLI locally).
   This creates `profiles`, `conversations`, `conversation_participants`,
   `messages`, `wallets`, and `ledger_entries`, all with RLS policies,
   and turns on Realtime for `messages`.
3. From **Project Settings → API**, grab:
   - the **Project URL** and **anon key** → these go in the
     *frontend's* `.env` (`EXPO_PUBLIC_SUPABASE_URL` /
     `EXPO_PUBLIC_SUPABASE_ANON_KEY`).
   - the **service_role key** → this goes ONLY in this backend's `.env`,
     never in the app.

## 2. Run the backend locally

```bash
cd zannychat-backend
cp .env.example .env
# fill in SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY in .env

# this project's own deploy uses Yarn (see the yarn.lock, and
# render.yaml's buildCommand/startCommand) — npm install / npm start
# work identically if you prefer it locally.
yarn install
yarn start
```

Check it came up:

```bash
curl http://localhost:3000/health
```

A healthy response looks like:

```json
{
  "status": "ok",
  "service": "zannychat-backend",
  "supabaseConfigured": true,
  "supabaseReachable": true,
  "supabaseError": null,
  "time": "2026-07-27T12:00:00.000Z"
}
```

`supabaseConfigured` just means the env vars are non-empty;
`supabaseReachable` means the service ran a real query against
Supabase and it worked — that's the one that actually proves the
deployment is wired correctly, not just that two strings were pasted
into Render's dashboard.

## 3. Deploy to Render

**Current status of this specific project:** this is deployed at
`https://zannychat-backend.onrender.com` with `SUPABASE_URL` and
`SUPABASE_SERVICE_ROLE_KEY` already set on the service.

**Option A — Blueprint (recommended):** push this folder to a Git repo,
then in Render choose **New → Blueprint** and point it at the repo.
`render.yaml` defines both the web service and the reconciliation cron
job; Render will prompt you for the env vars marked `sync: false`.

**Option B — manual:** create a new **Web Service** on Render, point it
at the repo, set:
- Build command: `yarn install`
- Start command: `yarn start`
- Add the env vars from `.env.example`

Either way, once it's live, note the service URL — you'll point the
frontend's webhook/payment provider (Stripe) at
`https://<your-service>.onrender.com/webhooks/stripe`.

## 4. Wire the frontend to this backend

The frontend already calls this backend's endpoints
(`src/services/api.js` → `createConversation`, `fetchWalletBalance`,
and `checkBackendHealth` for the Settings → Connections panel) — that
part doesn't need any more work. What activates it is `.env`:

```
EXPO_PUBLIC_SUPABASE_URL=https://your-project.supabase.co
EXPO_PUBLIC_SUPABASE_ANON_KEY=your-anon-key
EXPO_PUBLIC_BACKEND_URL=https://zannychat-backend.onrender.com
```

`src/services/supabaseClient.js` and `backendClient.js` in the frontend
detect those vars independently, but `createConversation` and
`fetchWalletBalance` both require *both* to be set — every authenticated
route here checks a Supabase session token (`requireAuth` in
`src/middleware/requireAuth.js`), so a backend URL with no session to
attach a token from can't do anything useful yet. `/health` is the one
route that needs neither, which is exactly why it's what the frontend's
diagnostics panel checks first.

## API reference

| Method | Path | Auth | Purpose |
|---|---|---|---|
| GET | `/health` | none | Render health check + live Supabase connectivity check |
| POST | `/conversations` | Bearer token | Create a conversation + add both participants |
| GET | `/wallet/balance` | Bearer token | Current user's ledger balance |
| POST | `/wallet/transfer` | Bearer token | Internal transfer between two wallets (demo money only) |
| POST | `/webhooks/stripe` | Stripe signature | Payment webhook receiver (501 until Stripe keys are set) |

"Bearer token" = the Supabase access token the frontend already holds
after sign-in (`supabase.auth.getSession()`), sent as
`Authorization: Bearer <token>`.

## What's intentionally a stub

- **Stripe webhook**: verifies signatures and logs the event, but
  doesn't credit a wallet yet — see the `TODO` in
  `src/routes/webhooks.js` for exactly where that logic goes.
- **Reconciliation job**: runs on schedule and logs, but has no payment
  provider to reconcile against yet.
- **AI worker (Phase 3)**: not built. When it's time, it's a third
  Render service (background worker) that reads from `messages` and
  writes summaries/translations back — this backend's structure
  (service-role Supabase client, route-per-concern) extends to that
  without changes to what's here.

## Project structure

```
src/
  index.js                Express app + route mounting
  config/supabaseAdmin.js  Service-role Supabase client (server-only)
  middleware/requireAuth.js Verifies the frontend's Supabase session token
  routes/
    health.js
    conversations.js
    wallet.js
    webhooks.js
  jobs/
    reconciliation.js       Run manually or via Render Cron
supabase/
  migrations/0001_init.sql  Full schema, RLS policies, Realtime setup
render.yaml                 Blueprint: web service + cron job
```
