## Current source version: 1.2.35

Shared conversation pins are introduced in migration `0041_shared_pinned_messages.sql`. See `../SHARED_PINS_1.2.84.md` in the delivery bundle for staging validation requirements.

# ZannyChat — Backend

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

- **Multi-step writes** (`/conversations`) — creating a conversation plus
  both participant rows in one trusted call, instead of asking the
  client to do two inserts against RLS.
- **AI features** (`/ai/*`) — the Anthropic API key lives only here.
- **Push notifications** (`/webhooks/new-message`) — the shared secret
  that authenticates the Postgres trigger lives only here.
- **Link previews** (`/link-preview`) — fetching an arbitrary URL
  server-side, with real SSRF guards, rather than from the client.

> **No wallet.** ZannyChat shipped an internal wallet/ledger preview
> early on; it's been removed so this project can focus on being a
> chat app. Payments now live in a separate, dedicated product. If
> you deployed an earlier version of this backend, run
> `supabase/migrations/0005_remove_wallet.sql` to drop the leftover
> `wallets`/`ledger_entries` tables from your database — see step 6
> below.

## 1. Set up Supabase

1. Create a project at [supabase.com](https://supabase.com).
2. Open the SQL editor and run `supabase/migrations/0001_init.sql`
   (or `supabase db push` if you're using the Supabase CLI locally).
   This creates `profiles`, `conversations`, `conversation_participants`,
   and `messages`, all with RLS policies, and turns on Realtime for
   `messages`. (It also creates `wallets` and `ledger_entries` — step 6
   below removes them again. Migrations run in order, as a historical
   record of what's actually been applied, rather than rewriting this
   file.)
3. Then run `supabase/migrations/0002_media_and_profile.sql` — adds
   `avatar_url` to profiles, adds attachment columns to `messages`
   (`media_url`, `media_type`, `media_name`, `media_size`,
   `shared_user_id`), and creates the `avatars` and `chat-media` Storage
   buckets with their own RLS policies. **This is a separate step even
   if you already ran 0001** — migrations don't rerun themselves.
4. Then run `supabase/migrations/0003_groups_voice_push.sql` — adds
   group-chat columns to `conversations`, a duration column to
   `messages` for voice notes, the `push_tokens` table, and a notification
   trigger. The trigger is intentionally a no-op until a backend URL and
   webhook secret are explicitly configured; applying migrations alone
   will not send traffic to any hosted service.
5. Then run `supabase/migrations/0004_unread_and_favorites.sql` — adds
   `last_read_at` and `is_favorite` to `conversation_participants`, an
   UPDATE policy for them (that table had none before — any attempt to
   write those columns would have silently failed under RLS), and turns
   on Realtime for that table too (that's what makes a "seen" tick
   update live while both people are in the conversation, not just
   after a refresh).
6. Then run `supabase/migrations/0005_remove_wallet.sql` — drops
   `wallets`, `ledger_entries`, and the trigger/function that kept them
   in sync. **Run this even on a brand-new project** — 0001 still
   creates those tables (it's left as-is, as a historical record), so
   every project needs 0005 to remove them again. Harmless to run twice.
7. Then run `supabase/migrations/0006_safety_reactions_and_hardening.sql`
   — adds `blocked_users` and `reports` with RLS, a block check in the
   messages INSERT policy, persisted Realtime reactions, message edit/delete
   fields, mute/archive flags, server-side Storage file-size limits, and a
   configurable push webhook URL. Push remains disabled until both
   `app.backend_url` and `app.webhook_secret` are configured.
8. Then run `supabase/migrations/0007_lock_down_row_mutations.sql`
   — restricts which columns authenticated users can update, prevents
   changing conversation membership through participant-row updates, and
   hardens message/reaction identity fields. The verification script at
   `supabase/tests/0007_row_mutation_hardening.sql` can be run by a database
   owner after applying the migration.
9. Then run `supabase/migrations/0008_guard_block_status_probe.sql` — hardens the SECURITY DEFINER block-check helper so authenticated users can only test their own sender identity in conversations they belong to. Verify it with `supabase/tests/0008_block_status_probe_guard.sql`.
10. **Coordinate private chat media with a compatible frontend before proceeding.** Apply migrations `0009_private_chat_media.sql`, `0010_fix_chat_media_rls_recursion.sql`, and `0011_fix_participant_rls_recursion.sql` in order. Together they convert known legacy chat-media URLs, make `chat-media` private, and replace recursive membership checks in Storage and core RLS policies. Verify with `supabase/tests/0009_private_chat_media.sql` and `supabase/tests/0011_participant_rls_recursion.sql`, then perform multi-user integration checks. Older clients using public media URLs may stop working.
11. Apply `supabase/migrations/0012_opt_in_push_webhook.sql`. It repairs existing databases so message notifications only post when both `app.backend_url` and `app.webhook_secret` are explicitly configured. Verify with `supabase/tests/0012_opt_in_push_webhook.sql`. For staging push tests, configure both settings with a dedicated dev backend and matching random secret; otherwise push stays disabled.
12. From **Project Settings → API**, grab:
   - the **Project URL** and **anon key** (or the newer
     `sb_publishable_...` key — same thing, new name) → these go in the
     *frontend's* `.env` (`EXPO_PUBLIC_SUPABASE_URL` /
     `EXPO_PUBLIC_SUPABASE_ANON_KEY`).
   - the **service_role key** (or `sb_secret_...`) → this goes ONLY in
     this backend's `.env`, never in the app.

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

**Development guidance:** do not deploy to production just to continue frontend work. Run locally with mock data, or use a dedicated staging backend and database when integration testing is needed. This repository does not establish that any remote service is deployed or configured.

**Option A — Blueprint (recommended):** push this folder to a Git repo,
then in Render choose **New → Blueprint** and point it at the repo.
`render.yaml` defines the web service; Render will prompt you for the
env vars marked `sync: false`.

**Option B — manual:** create a new **Web Service** on Render, point it
at the repo, set:
- Build command: `yarn install`
- Start command: `yarn start`
- Add the env vars from `.env.example`

Either way, once it's live, note the service URL — that's what goes
in the frontend's `EXPO_PUBLIC_BACKEND_URL`.

## 4. Wire the frontend to this backend

The frontend already calls this backend's endpoints
(`src/services/api.js` → `createConversation`, `createGroupConversation`,
the `/ai/*` and `/link-preview` calls, and `checkBackendHealth` for the
Settings → Connections panel) — that part doesn't need any more work.
What activates it is `.env`:

```
EXPO_PUBLIC_SUPABASE_URL=https://your-project.supabase.co
EXPO_PUBLIC_SUPABASE_ANON_KEY=your-anon-key
EXPO_PUBLIC_BACKEND_URL=https://your-dev-backend.example.com
```

`src/services/supabaseClient.js` and `backendClient.js` in the frontend
detect those vars independently, but `createConversation` and the other
backend-routed calls all require *both* to be set — every authenticated
route here checks a Supabase session token (`requireAuth` in
`src/middleware/requireAuth.js`), so a backend URL with no session to
attach a token from can't do anything useful yet. `/health` is the one
route that needs neither, which is exactly why it's what the frontend's
diagnostics panel checks first.

## API reference

| Method | Path | Auth | Purpose |
|---|---|---|---|
| GET | `/health` | none | Render health check + live Supabase connectivity check |
| POST | `/conversations` | Bearer token | Create a 1:1 conversation + add both participants |
| POST | `/conversations/group` | Bearer token | Create a group conversation (2+ other participants + a name) |
| POST | `/ai/smart-replies` | Bearer token | 3 suggested replies to the latest message (501 until `ANTHROPIC_API_KEY` is set) |
| POST | `/ai/summarize` | Bearer token | Bullet-point summary of a conversation |
| POST | `/ai/translate` | Bearer token | Translate arbitrary text — no frontend UI wired to it yet |
| POST | `/webhooks/new-message` | Internal secret | Called by the Postgres trigger on every message — sends push notifications to other participants (skips muted conversations and anyone who blocked the sender) |
| GET | `/link-preview?url=` | Bearer token | Open Graph metadata (title/description/image) for a shared link |
| POST | `/safety/block` | Bearer token | Block a user — they can no longer message you (enforced by RLS on `messages`, too) |
| POST | `/safety/unblock` | Bearer token | Remove someone from your block list |
| GET | `/safety/blocked` | Bearer token | List your own block list (with profiles joined) |
| POST | `/safety/report` | Bearer token | File a report against a user, optionally attached to a message |

### Rate limiting

Added in 1.1 after the Oct 2026 security audit found none. Every
user-facing router throttles per **authenticated user id** (falling
back to IP for unauthenticated requests) via `express-rate-limit`:

| Router | Limit | Why |
|---|---|---|
| `/ai/*` | 10 req/min | Every call spends real Anthropic tokens against this project's key |
| `/link-preview` | 30 req/min | Server-side fetching of arbitrary URLs |
| `/conversations` | 60 req/min | Generous — normal use is a few calls per session |
| `/safety` | 30 req/min | Mass-block / report-flood protection |

A throttled request gets `429` with a JSON `error` message the app can
show as-is. `trust proxy` is set to exactly 1 hop (Render's proxy), so
the IP fallback keys on the real client, not the load balancer.

"Bearer token" = the Supabase access token the frontend already holds
after sign-in (`supabase.auth.getSession()`), sent as
`Authorization: Bearer <token>`. "Internal secret" = `INTERNAL_WEBHOOK_SECRET`,
sent by the Postgres trigger, not by any user — see the migration setup
step above.

Every `/ai/*` route checks the caller is actually a participant in the
conversation it's asked about before spending any tokens — see
`assertParticipant` in `src/routes/ai.js`. That check uses the
service-role client (it has to, to bypass RLS and look), so it's the
one place in this codebase doing by hand what RLS does everywhere else.

Unread counts, read receipts, and favorites (0004) need **no backend
route at all** — the frontend reads/writes `conversation_participants.last_read_at`
and `.is_favorite` directly against Supabase, gated by the RLS policy
that migration adds. Nothing for this backend to do there but stay out
of the way.

## How push notifications actually fire

Worth understanding as one pipeline, since it spans Postgres and this
backend:

1. Any `INSERT` on `messages` fires the `on_message_created` trigger
   (see `0003_groups_voice_push.sql`).
2. That trigger calls `net.http_post` (via the `pg_net` extension) to
   this backend's `/webhooks/new-message` — async and fire-and-forget
   from Postgres's side, so a slow or down backend can never block a
   message from sending.
3. `/webhooks/new-message` (in `src/routes/internal.js`) verifies the
   shared secret, looks up everyone else in that conversation, and
   calls `sendPushToUser` for each of them.
4. `src/config/pushClient.js` wraps `expo-server-sdk` — it batches
   requests properly and, if Expo reports a token as
   `DeviceNotRegistered` (an old install, a factory reset), deletes it
   from `push_tokens` automatically rather than leaving it to fail
   silently forever.

The frontend side (registering a device, storing its token) needs a
**development build**, not Expo Go — see the frontend README for why
and how to set that up. Nothing on this backend needs that; it'll send
correctly the moment `INTERNAL_WEBHOOK_SECRET` is set and a real token
exists in `push_tokens`.

## What's intentionally a stub

- **`/ai/translate`**: built and working, but the frontend doesn't call
  it from anywhere yet (no per-message "translate" button in the chat
  UI). `/ai/smart-replies` and `/ai/summarize` are both wired end to
  end — set `ANTHROPIC_API_KEY` on Render and they work immediately,
  no redeploy of the frontend needed.
- **Group chats have no admin layer** — anyone in a group can post;
  there's no owner, no kick/promote, no invite-link flow. A deliberate
  scope limit on `POST /conversations/group`, not an oversight.
- **Group read receipts** — a 1:1's "seen" tick is real (see 0004); a
  group's "seen by 4 of 6" is a genuinely different feature (whose
  avatars do you show, in what order) that this doesn't attempt. Group
  messages always show as sent, never read.

## Tests

Added in 1.1 — the audit found zero automated tests. Jest + Supertest,
with the Supabase client mocked at the module boundary:

```bash
npm install
npm test
```

Current coverage targets the most security- and integrity-sensitive
paths first (the audit's own recommendation): `requireAuth` token
handling, the rate limiter's key strategy, the webhook's constant-time
secret check + muted/blocked recipient filtering, and
`/conversations`' validation, block refusal, and rollback-on-failure
path. RLS policy tests (pgTAP) and an end-to-end two-account message
test are the documented next layers.

## Project structure

```
src/
  index.js                Express app + route mounting
  config/
    supabaseAdmin.js       Service-role Supabase client (server-only)
    aiClient.js              Thin fetch wrapper around Anthropic's Messages API
    pushClient.js             Wraps expo-server-sdk, prunes stale tokens
  middleware/
    requireAuth.js         Verifies the frontend's Supabase session token
    rateLimit.js           Per-user throttles (express-rate-limit)
  routes/
    health.js
    conversations.js         1:1 (POST /) and group (POST /group) creation — refuses blocked pairs
    ai.js                    smart-replies, summarize, translate
    internal.js                new-message → push (constant-time secret check; skips muted/blocked)
    linkPreview.js              Fetches a URL's Open Graph tags — has real SSRF guards
                                (blocks localhost/private-IP hostnames), not just a naive proxy
    safety.js                   block / unblock / list-blocked / report
supabase/
  migrations/
    0001_init.sql          Core schema, RLS policies, Realtime setup
    0002_media_and_profile.sql  Avatars, chat attachments, Storage buckets + RLS
    0003_groups_voice_push.sql   Group columns, voice duration, push_tokens + trigger
    0004_unread_and_favorites.sql  last_read_at, is_favorite, UPDATE policy, Realtime
    0005_remove_wallet.sql   Drops wallets/ledger_entries and their trigger
    0006_safety_reactions_and_hardening.sql  Block & report, message_reactions, edit/delete,
                                mute/archive, Storage size limits, configurable push URL
    0007_lock_down_row_mutations.sql  Restrict mutable columns and protect row identity
    0008_guard_block_status_probe.sql  Restrict direct probing of block relationships
  tests/
    0007_row_mutation_hardening.sql  Database ACL/policy/trigger verification (run manually)
    0008_block_status_probe_guard.sql  Block-helper privilege/guard verification
tests/
  helpers/mockSupabase.js  Thenable query-builder mock for the supabase-js client
  conversations.test.js    Validation, block refusal, happy path, rollback
  internal.test.js         Webhook secret auth + recipient filtering
  rateLimit.test.js        Key generation strategy
  linkPreview.test.js      SSRF host blocklist
render.yaml               Blueprint: web service
```


### Push receipt tracking (backend 1.2.17)

After applying migration `0030_push_receipt_tracking.sql`, configure a trusted scheduler to POST to `/webhooks/push-receipts` every 10 minutes or more frequently, with `Authorization: Bearer <INTERNAL_WEBHOOK_SECRET>`. Expo tickets are checked after 15 minutes; missing receipts remain pending for later retry. See `PUSH_RECEIPT_TRACKING_1.2.17.md`. Do not expose the shared secret in the app client.


### Channel moderator roles (1.2.24)
Apply migration `0036_channel_moderators.sql` after the channel post migrations. Channel owners can appoint subscribed members as moderators. Moderators may pin/unpin and delete posts and remove comments, but cannot publish/edit posts or delete the channel. Test with separate owner, moderator, subscriber, and unrelated accounts before deployment.


### Channel metadata settings (1.2.25)
Channel owners can edit the channel name and description using `PATCH /channels/:channelId`. The API validates field lengths and checks owner identity; no migration is needed.


### Channel post reports (1.2.26)

Subscribers can report channel posts using a bounded reason set. Each account may file one report per post. Channel owners and active moderators can view open reports and mark them reviewed or dismissed. Migration `0037_channel_post_reports.sql` creates the protected report table; apply it after migrations `0033`–`0036`. Direct client table access is revoked; authenticated API routes mediate writes and moderation. Hosted integration and multi-account tests remain required.

### Release 1.2.30 — channel directory search
`GET /channels?q=...` supports bounded title/description search while retaining the directory's private-channel ownership/subscription filters. No migration is required. See the root `CHANNEL_SEARCH_1.2.78.md` delivery note.

### Release 1.2.33 — group rename and invite history
The group metadata PATCH endpoint optionally accepts a bounded group name while preserving compatibility with clients that only update topic/description. `GET /conversations/:conversationId/invites` returns at most 50 invite status records to current group admins only; raw tokens and token hashes are never returned. No migration is required. Live database/API integration and device validation remain pending.

### Release 1.2.34 — group announcement mode
Apply `0040_group_announcement_mode.sql` after all prior migrations. Group admins can toggle announcement mode in Group Management; the database's message INSERT RLS policy enforces that only admins may send while it is enabled. Existing conversations default to normal member messaging. Test with separate admin and non-admin accounts in staging before production.
