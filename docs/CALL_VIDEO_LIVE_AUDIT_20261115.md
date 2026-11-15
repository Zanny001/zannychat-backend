# ZannyChat Call, Video and LIVE Audit — 2026-11-15

## Scope

Reviewed the native and web call screens, group-call/conference admission, Supabase call/LIVE data access, LiveKit token permissions, LIVE guest/reaction/replay routes, replay worker lifecycle, call history, and production Render/Supabase logs.

## Findings and remediation in this audit

| Area | Finding | Remediation |
|---|---|---|
| Direct calls | ICE restart was restricted to the original caller, leaving the callee with weaker recovery when their network changed | Native and web clients now allow either participant to initiate ICE restart while retaining deterministic offer-collision handling |
| Direct calls | Navigating away from an active call could close local media without reliably ending the call row | Native and web screens now intercept route removal and persist the valid end/decline/cancel transition |
| Direct calls | A peer could remain disconnected indefinitely while the other side kept the shared call heartbeat alive | A 120-second unrecovered ICE disconnect grace period now ends the call and releases the UI/session |
| Call lifecycle | Exiting a ringing incoming call could request an invalid `ended` transition instead of `declined` | Call exit policy now maps ringing caller exits to `cancelled`, ringing callee exits to `declined`, and accepted calls to `ended` |
| Call lifecycle | The stale-signal cleanup function existed but was not scheduled on this project; expired accepted sessions could remain labelled in progress in history | Added a single-instance Render worker to run cleanup every minute and finalize accepted sessions after their three-minute lease expires; the trigger permits participants or the service-role cleanup worker to make that transition |
| Call history | A one-to-one call upgraded to a group conference could appear twice in history | Conference-linked source calls are excluded from the direct-call history list |
| Group calls | Block relationships were checked at creation/invitation but not consistently rechecked when an existing room was joined | Group-call and direct-conference join functions recheck bidirectional blocks against connected participants at admission |
| Group calls / LIVE | Abrupt disconnects could leave stale participants counted as joined, consuming room/audience/stage capacity | Added 30-second client heartbeats and a three-minute server lease cleanup; stale group participants are released, empty rooms end, stale viewers/guests leave, and a stale LIVE creator ends the stream |
| Group calls | A participant whose row was marked left due to a heartbeat timeout needed a safe reconnect path | Join functions allow stale-timeout rejoin only when last-seen predates the cleanup leave timestamp; explicit leave remains non-rejoinable |
| LIVE request load | Shared 30 requests/minute budget was too low for normal concurrent comments, guest-request and replay polling | Shared LIVE budget raised to 90/minute; reactions/comments retain tighter endpoint-specific limits |
| LIVE guest flow | Guest requests and invitations lacked dedicated anti-spam caps | Guest requests limited to 3/minute and creator invitations to 5/minute |
| LiveKit permissions | Viewers and group-call participants could publish unused arbitrary data-channel packets | Data-channel publishing disabled for all current LIVE and group-call roles; media track permissions remain role-scoped |
| Native audio routing | Group calls and LIVE had no explicit in-app speaker/earpiece route control | Added LiveKit audio output selection for Android and the native iOS route picker on group-call and LIVE screens |
| LIVE ending | The end route stopped replay Egress before checking creator ownership, allowing an authenticated non-creator to disrupt another stream's replay | Creator authorization/state transition now succeeds before Egress stop or room deletion |
| LIVE cleanup | Ending a broadcast did not guarantee its LiveKit room was deleted | Creator end and broadcast deletion remove the generated LIVE room; a retrying worker removes ended rooms after active replay Egress has stopped |
| Replay lifecycle | Replay Egress could remain active after a stream ended outside the normal creator end route | Replay recovery worker now stops Egress when the parent stream is ended or missing |

## Security posture checked

- Call sessions and call signals are protected by row-level policies and participant validation; call-signal payloads already have a 16 KiB database limit and sender rate guard.
- LIVE stream, participant, guest-invite, reaction, replay and impact data are accessed through the backend service role rather than direct anonymous/authenticated table grants.
- The authenticated call heartbeat RPC is scoped to the caller's own participation in the call.
- In the call/LIVE function surface, `heartbeat_call_session` is the only SECURITY DEFINER RPC callable by authenticated users; it requires `auth.uid()` and updates only a call where that user is caller or callee. All other audited call/LIVE privileged functions are service-role-only.
- Supabase security advisor reports 36 RLS-enabled tables without policies; the audited call/LIVE tables are intentionally service-role-only and have no anon/authenticated SELECT grants. The advisor also reports 27 authenticated-callable SECURITY DEFINER functions across the wider app; the call/LIVE subset was reviewed as above.
- The platform-wide leaked-password protection setting is disabled; this is outside the call/LIVE changes and should be enabled when the Supabase plan/settings support it.
- The LIVE replay Storage bucket is private and has no public object policy; playback uses the authenticated backend playback path and short-lived signed URLs.
- LiveKit room names are constrained to generated ZannyChat namespaces before room deletion.
- LiveKit data publishing is disabled where no current client data-channel feature uses it.

## Existing product limits / operational constraints

- LIVE replay recording is capped at five minutes and 48 MB. The current 360p/500 kbps video plus 64 kbps audio profile is sized below that storage limit; longer replays require an explicit storage/egress budget decision.
- Reactions and comments are server-persisted and then polled; they are not a guaranteed sub-second real-time transport.
- Web audio output selection remains controlled by the browser/operating system; the new explicit output picker is native-only.
- The app still needs a two-account browser/device acceptance test for guest request → creator approval → guest stage join, audio/video track publication, reactions, and guest reconnect.
- Android Kotlin compilation and debug APK packaging are CI checks, not physical-device call/audio-route verification.
- A new real LIVE broadcast is still required to verify Egress upload, replay completion, signed playback, and delete end-to-end.

## Verification notes

- Production logs reviewed for call/LIVE HTTP 5xx and replay Storage errors in the audit window; no matching PostgREST 5xx or LIVE replay Storage failures were returned.
- Supabase performance advisor found three missing LIVE foreign-key indexes (impact daily supporter, impact supporters, replay quota active replay); these indexes are added by the heartbeat migration. The advisor also lists many unused indexes; none were removed without representative production workload evidence.
- Earlier database errors included expected state/authorization rejections (expired/non-participant call heartbeat, active-call guard, and duplicate active LIVE creator constraint). A missing-column message in the log window came from an audit SQL query referencing a non-existent column, not from the app.
- This document describes the code and database checks in scope; it does not claim a real two-user media session was completed by automation.
