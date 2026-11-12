# Phase 2 — Durable native call-end notifications

## Problem

Native call termination already reconciles the durable call session using a signed participant-bound token. However, the follow-up FCM/APNs alert to the other participant was a single best-effort attempt. A transient provider outage or a recipient who had not registered a device token could leave the remote OS call surface without a terminal event.

## Change

- Add a backend-only `call_end_notifications` queue with one row per call and recipient, including a covering recipient foreign-key index.
- Enqueue the terminal event after the signed native event updates the call session, and when the authenticated `end-notify` endpoint is used.
- Claim due notifications with `FOR UPDATE SKIP LOCKED` and a two-minute processing lease.
- Retry provider failures and missing device tokens with bounded exponential backoff; expire after 12 attempts.
- Run a background worker every 30 seconds and immediately attempt delivery after enqueue.
- Keep APNs PushKit reserved for incoming calls. Terminal fallback delivery continues to use Android FCM data messages and standard iOS APNs alerts; standard alerts are not represented as guaranteed CallKit dismissal.

## Security

The queue is inaccessible to `anon` and `authenticated` database roles. Only the backend service role can read/write queue rows and execute the claim RPC. Signed call-event verification and participant authorization remain unchanged. No provider credentials are added to the mobile app.

## Validation

The existing `npm run test:call-notifications` suite now covers:
- service-only RLS/privileges and the claim lease;
- successful delivery and terminal queue state;
- missing-token retry with bounded backoff;
- idempotent enqueue and immediate delivery attempt;
- route and worker integration.

## Release gates

1. The additive migrations `20261112104335_durable_call_end_notifications.sql` and `20261112104520_index_call_end_notifications_recipient_id.sql` were applied to production Supabase on 2026-11-12 and recorded in the remote migration ledger.
2. Post-apply privilege verification confirmed RLS enabled, no SELECT privilege for `anon` or `authenticated`, and service-role-only access to the queue and claim RPC.
3. Verify Render has the correct FCM service-account JSON and APNs alert credentials before relying on device delivery.
4. Test incoming call, native decline, caller cancellation, unanswered timeout, active remote end, process death and token re-registration on physical Android and iOS devices.
5. Confirm queue rows reach `delivered` when provider delivery is accepted and retry/expire correctly when providers are unavailable.
6. Do not claim Android cold-start Telecom UI dismissal or guaranteed iOS CallKit dismissal from standard APNs alerts; those remain platform/device-specific release gates.

The migration is applied, but this PR is not merged or deployed to Render.
