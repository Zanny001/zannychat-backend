# ZannyChat Call, Video and LIVE Audit — 2026-11-15

## Scope

Reviewed the native and web call screens, group-call/conference admission, Supabase call/LIVE data access, LiveKit token permissions, LIVE guest/reaction/replay routes, replay worker lifecycle, call history, and production Render/Supabase logs.

## Feature inventory reviewed

- **Direct audio/video calls:** outgoing and incoming call flows; accept, decline, cancel, missed and end states; WebRTC peer connections; STUN/TURN ICE configuration; mute/unmute; camera on/off; front/back camera switching; audio-to-video and video-to-audio switching; caller/callee ICE restart; native speakerphone control; remote audio playback; call history, redial and per-user deletion.
- **Group calls and conferences:** direct-call promotion to a group room; invitation of additional conversation members; participant admission and block checks; LiveKit audio/video tracks; participant roster; microphone/camera controls; leave versus end behavior; native speaker/earpiece selection; group call history and deletion.
- **LIVE broadcasts:** public, follower-only and private visibility; creator, viewer, moderator and guest roles; guest requests and creator invitations; multi-guest stage; stage capacity; creator/guest camera and microphone controls; viewer comments and emoji reactions; moderation (mute, remove, spotlight, demote, reports); creator impact/supporter scores; separate Live Hub profile; replay Egress, signed playback, replay deletion and past-broadcast deletion.
- **Cross-platform:** native Android/iOS and web screen paths, LiveKit token permissions, authenticated backend routes, Supabase RLS/grants, private replay storage, cleanup workers, rate limits and production logs.

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
| Group calls / LIVE | Abrupt disconnects could leave stale participants counted as joined, consuming room/audience/stage capacity | Added 30-second client heartbeats and a three-minute opt-in server lease cleanup; legacy clients are not expired until they send their first heartbeat; stale group participants are released, empty rooms end, stale viewers/guests leave, and a stale LIVE creator ends the stream |
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
- Backend CI now includes the dedicated call/LIVE history-deletion regression suite on the next main-branch workflow run.
- Production currently has reaction/creator-impact rows, but the replay table has no records at audit time; a new LIVE ending with replay enabled is required to verify Egress upload, object existence, signed playback and deletion end to end.
- The presence cleanup is intentionally opt-in: older web/APK clients that do not send the new heartbeat keep their legacy presence behavior until updated, avoiding accidental disconnection during rollout. New clients opt in on the first connected-room heartbeat.
- Android Kotlin compilation and debug APK packaging are CI checks, not physical-device call/audio-route verification.
- A new real LIVE broadcast is still required to verify Egress upload, replay completion, signed playback, and delete end-to-end.

## Verification notes

- Production logs reviewed for call/LIVE HTTP 5xx and replay Storage errors in the audit window; no matching PostgREST 5xx or LIVE replay Storage failures were returned.
- Supabase performance advisor found three missing LIVE foreign-key indexes (impact daily supporter, impact supporters, replay quota active replay); these indexes are added by the heartbeat migration. The advisor also lists many unused indexes; none were removed without representative production workload evidence.
- Earlier database errors included expected state/authorization rejections (expired/non-participant call heartbeat, active-call guard, and duplicate active LIVE creator constraint). A missing-column message in the log window came from an audit SQL query referencing a non-existent column, not from the app.
- This document describes the code and database checks in scope; it does not claim a real two-user media session was completed by automation.


## Product gaps found (not regressions in the repaired flows)

- No screen-sharing control or picture-in-picture flow was found in the current direct-call, group-call or LIVE screens.
- Private direct/group calls do not expose a recording workflow; recording/replay is implemented for LIVE broadcasts only.
- Web audio-device routing remains delegated to browser/OS controls; explicit output selection is native-only.
- LIVE comments and emoji reactions are persisted and polled, so visual updates are not guaranteed to be sub-second. A secured realtime transport would be a separate enhancement.
- Background/screen-locked call continuity and Bluetooth routing require physical Android/iOS acceptance testing; CI compilation cannot prove device audio behavior.

## Production schema rollout verification

- Applied migrations `20261115014903`, `20261115014920`, `20261115014925`, and `20261115015502` to Supabase project `vithpppgyjmazxvogvno`.
- Verified `last_seen_at` is nullable with no default on both media participant tables; existing joined rows were reset to NULL so legacy clients are not opted into lease expiry.
- Verified all privileged call/LIVE join, leave and cleanup RPCs are executable by `service_role` only; anon and authenticated execution are denied.
- Verified there were no currently joined LIVE/group-call participant rows at the opt-in migration point, so no active sessions were expired by rollout.
- Supabase performance advisor no longer reports the three missing LIVE foreign-key indexes; remaining unused-index notices are retained for workload-based review.


## LIVE follow-up — 2026-11-20

This addendum supersedes earlier replay-row counts in this document where they conflict with the current read-only snapshot.

### Confirmed changes

- Frontend PR #210 is merged: creator-only END LIVE is explicit and confirmation-gated on native and web; viewers retain a separate LEAVE action; native/web floating guest tiles use an adaptive non-overlapping layout. Frontend CI passed on the PR head.
- Frontend PR #208 is merged: Creator Studio now links to Events, Preferences and Rankings; all PR checks passed.
- Backend PR #166 is merged: the creator may send LIVE reactions without a viewer/guest participant-row prerequisite, while viewers and guests still require an active joined participant. The change has no migration and backend tests/quality checks passed.
- The authenticated production record_live_creator_impact function is the creator-aware version, uses an empty pinned search_path, grants EXECUTE to service_role, and denies it to authenticated.
- The eight inspected LIVE core tables retain RLS and no direct anon/authenticated SELECT privileges; service_role retains SELECT.
- live-replays remains private, MP4-only, and capped at 48,000,000 bytes.

### Fresh read-only production snapshot

- One LIVE stream is currently active; no end, leave, update, or cleanup action was issued during this audit.
- The account's ended-broadcast deletion flow removed multiple ended stream rows and their associated private replay objects. The audit logs show a prior replay row was created and subsequently processed before the history deletions.
- Current live_stream_replays row count: zero. Current storage.objects count for live-replays: zero. Therefore there is no current replay available to play; this is consistent with the deleted broadcast history and is not evidence that a new Egress recording failed.
- Supabase edge logs show successful reads for replay rows and reaction feeds. The recent window also contains successful record_live_creator_impact RPC requests; however, those database requests do not prove that the current creator's UI request reached the route or that media was delivered.
- The active stream snapshot contains a joined creator participant row. No current-stream reaction rows were present in the snapshot.

### Remaining release gates

1. Pull frontend and backend main locally and run the project test/release commands.
2. Verify the merged frontend on a deployed build. The Vercel deployment integration reported its free daily deployment limit, so a Ready preview must not be mistaken for a production deployment.
3. On a future controlled LIVE session, verify creator re-entry returns a server-issued creator role, the visible END LIVE action works only for the creator, and cancellation keeps the stream active.
4. Verify creator and viewer/guest reactions separately, including creator self-reaction not awarding self-impact.
5. Start a fresh replay on a test broadcast; verify recording → processing → ready, private object existence, signed playback for an eligible account, denial for an ineligible account, owner deletion, and seven-day expiry cleanup.
6. Complete two-account browser and two-physical-device native tests for remote video/audio, guest approval/demotion, camera/microphone toggles, reconnect, moderation, and stream teardown.

No production migration, permission change, or data mutation was performed for this addendum.
