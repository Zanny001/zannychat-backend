# Phase 3 — Group-call SFU teardown

## Problem

The group-call database lifecycle is atomic, but ending a room in Postgres does not itself disconnect participants already connected to the LiveKit SFU. A host could see the call end in ZannyChat while remote participants remained connected to the media room.

## Change

- Add a 30-second LiveKit server-side JWT carrying only the `roomCreate` grant required by the DeleteRoom API. LiveKit does not offer a room-scoped grant for DeleteRoom, so this credential is never returned to clients and exists only for the server-side deletion request.
- Call LiveKit's `RoomService/DeleteRoom` API after the host/admin successfully ends a group call.
- Track successful media teardown separately from the durable call record using `group_call_rooms.media_terminated_at`.
- Run a backend retry worker every 30 seconds for ended rooms whose media teardown is still pending.
- Keep group-call history intact; deleting the SFU room does not delete call records or participant history.
- Do not expose LiveKit API credentials or room-admin tokens to the mobile/web client.

## Failure behavior

The database end remains authoritative. If the SFU is temporarily unreachable, the API reports `mediaTerminationPending: true`, leaves the marker unset, and the worker retries. The cleanup operation is idempotent: an already-absent room counts as successfully terminated.

## Validation

The existing `npm run test:group-calls` suite now also verifies:
- room-admin JWT signature, expiry and room scope;
- the authenticated Twirp deletion request;
- rejection of malformed room names;
- success markers and retryable failure behavior;
- the partial index that selects only ended rooms pending teardown.

## Deployment gates

1. Review and apply `20261112104338_group_call_media_teardown.sql` to the intended Supabase environment before deploying this backend commit.
2. Confirm `LIVEKIT_URL`, `LIVEKIT_API_KEY`, and `LIVEKIT_API_SECRET` are configured as server-only Render environment variables.
3. Run the backend quality workflow.
4. Test host end, admin end, participant leave, reconnect, and SFU outage/recovery with at least three authenticated devices.
5. Confirm all remote participants are disconnected and group-call history remains available.

No production migration or Render deployment is performed by this PR.
