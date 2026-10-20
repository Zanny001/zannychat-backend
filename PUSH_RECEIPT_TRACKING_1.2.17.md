# Push receipt tracking — backend 1.2.17

## What changed
- Successful Expo push tickets are persisted in `push_receipt_tickets` with their ticket ID, user, token, and send timestamp.
- The protected `POST /webhooks/push-receipts` endpoint checks eligible tickets with Expo's receipt API after a 15-minute delay.
- Confirmed provider receipts are stored as `ok` or `error`; missing receipts remain pending and are eligible for another attempt after 10 minutes.
- `DeviceNotRegistered` receipt errors trigger best-effort cleanup of the corresponding token from `push_tokens`.
- The migration grants no table access to `anon` or `authenticated`; only the backend service-role client should access this table.

## Apply and schedule
1. Apply `supabase/migrations/0030_push_receipt_tracking.sql` after migration `0029_status_contact_exclusions.sql`.
2. Deploy backend 1.2.17 with the existing `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, and `INTERNAL_WEBHOOK_SECRET` configuration.
3. Configure a trusted scheduler to POST to `/webhooks/push-receipts` at least every 10 minutes, sending `Authorization: Bearer <INTERNAL_WEBHOOK_SECRET>`. Keep the secret in the scheduler's secret store; do not put it in the mobile app or a public client.
4. Monitor backend logs and the endpoint's summary. A receipt status of `ok` means Expo's receipt provider reports acceptance/delivery processing; it is still not proof the operating system displayed a notification to a human.

## Safety and limitations
- The endpoint is protected by the same internal webhook secret as message notifications.
- It processes up to 1,000 eligible ticket records per invocation; invoke it periodically to drain backlog.
- Provider lookup failures leave tickets pending for retry.
- No production migration, scheduler, real push, or physical-device test was run in this source pass. Verify migration and endpoint behavior in staging first.
