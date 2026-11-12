# Phase 7 — Operations, observability and resilience

This phase adds low-overhead request diagnostics without introducing a paid vendor, a new runtime dependency, or a production database change.

## Request observability

The API emits one structured JSON log record when each response finishes. Records contain only:
- UTC timestamp and server-generated request correlation ID
- HTTP method and matched Express route template (not the raw URL)
- response status and elapsed milliseconds

The middleware deliberately excludes query strings, request/response bodies, authorization headers, cookies, IP addresses, user IDs, message IDs, and provider error text. The response includes `X-Request-Id` so support can correlate a client report with platform logs without asking users to share private message content.

## Health checks

- `GET /health/live`: process liveness; no database dependency.
- `GET /health/ready`: bounded Supabase connectivity probe; returns 503 when the database is unavailable.
- `GET /health`: backward-compatible platform health response.

Use liveness for process monitoring and readiness for deployment acceptance. Do not interpret liveness as proof that messaging, push, calls, or LIVE media are healthy.

## Free-tier operating limits

- Keep Render on the existing free plan unless the owner separately approves a paid upgrade. Free services may sleep and have platform-specific availability limits; do not promise always-on uptime.
- Keep Supabase on the existing Free plan. Do not add paid observability extensions or Pro-only backup/PITR features.
- GitHub Actions checks are source-level validation, not a substitute for production synthetic tests or real APNs/FCM/LiveKit delivery tests.
- Avoid frequent artificial health pings to prevent wasting free compute or masking cold-start behavior.

## Recovery and release procedure

1. Check `/health/live`, then `/health/ready`; preserve the status code and timestamp.
2. Search Render logs by the returned `X-Request-Id` and the structured `requestId` field. Never paste secrets or message bodies into issues.
3. For Supabase incidents, inspect provider status and project logs before attempting schema changes.
4. Before a migration, reconcile local and remote migration history, inspect the exact SQL, and take an available export/backup. Never use `db push --include-all`, migration repair, or reset as a shortcut.
5. Restore only into an isolated staging project first; verify auth, RLS, storage privacy, realtime, push, calls, and LIVE before production recovery.
6. After recovery, run backend CI, client CI, health probes, and two-account privacy acceptance.

## Explicitly not claimed by this phase

No external paid monitoring account, always-on uptime guarantee, point-in-time recovery, automated production backup, APNs/FCM delivery proof, LiveKit network proof, physical-device test, or production deployment is created by this source change. Those require provider/account access and operational acceptance.
