# Push delivery reliability — backend 1.2.16

## Changes

- Push sending now counts only Expo push tickets with `status: "ok"` as accepted.
- Failed and malformed/truncated ticket responses are counted as failures rather than being mistaken for sends.
- `DeviceNotRegistered` tokens are deduplicated before best-effort cleanup; cleanup errors are logged without hiding the send result.
- `sent` means accepted by Expo for processing, not delivered or displayed on the recipient device.
- Added unit coverage for successful tickets, provider failures, stale-token cleanup decisions, and malformed responses.

## Verification boundary

Unit tests and syntax checks cover ticket summarization. No real Expo push was sent, no live Supabase token rows were modified, and no device delivery receipt was observed. Expo's later receipt API is not polled in this increment, so this release must not be described as end-to-end delivery confirmation.
