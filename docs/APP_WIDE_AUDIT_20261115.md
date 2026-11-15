# ZannyChat whole-app audit — 2026-11-15

**Status:** Initial deep audit in progress. This report distinguishes verified repository/database findings from workflows that still require physical-device or two-account acceptance testing. It is not a penetration-test certification.

## Scope inspected

- Frontend screens, navigation-facing modules, API/service layer, native/web startup, profile editing, attachment handling and release workflows.
- Backend routes/jobs, call/video/LIVE fixes, replay Egress, cleanup workers and CI.
- Live Supabase migration ledger, table/column grants, RLS policies, SECURITY DEFINER grants/definitions, storage buckets and object policies.
- Netlify production deployment and Render deployment metadata.
- OWASP MASVS categories: storage, cryptography, authentication/authorization, network, platform, code quality, resilience and privacy.

## Feature inventory

- Account onboarding, email/password sign-in, email verification, password recovery, OAuth callbacks and session restoration.
- Profiles, usernames, QR contact lookup, public profile discovery, profile details, presence, photo visibility, blocking and reporting.
- One-to-one chats, groups, message history, replies, edits, deletion modes, reactions, read receipts, pinned/saved messages, drafts, scheduled messages, folders and shared media.
- Images, videos, generic files, voice notes, shared contacts, retryable attachment uploads and attachment cleanup.
- Status updates with audiences, exclusions, expiry, views, replies and media.
- Channels, posts, subscriptions, comments/reactions and moderation/reporting.
- Events and polls.
- Direct audio/video calls, call history, network recovery, ICE restart, TURN, native call lifecycle, audio routing, group/conference calls and participant admission.
- LIVE creator/viewer flows, visibility controls, guest requests/invitations, stage moderation, comments, reactions, impact/supporter score, replay history and deletion.
- AI smart replies/summaries, link previews, data export, settings, themes, notifications, storage management and help.
- Backend routes and scheduled workers for calls, group calls, LIVE, replay Egress, attachment cleanup, notifications and stale-presence cleanup.

## Verified fixes completed during this audit

### Storage upload limits — applied to production Supabase

Migration `20261115084203_enforce_chat_media_upload_limits` was applied and recorded in the Supabase migration ledger, and the same SQL was committed to backend `main`:

- `chat-media`: server-side maximum is now 25 MiB, matching the Chat screen limit.
- Legacy public `avatars`: server-side maximum is now 10 MiB and allowed MIME types are JPEG, PNG and WebP.
- `private-avatars`, `status-media` and `live-replays` retain their existing limits.

Before this change, `chat-media.file_size_limit` was NULL despite a frontend comment claiming the 25 MiB limit was enforced server-side. The client-side check alone was bypassable.

### Profile privacy compatibility — frontend PR in progress

The live database still has the policy `Profiles are viewable by any signed-in user` with `USING (true)`. Authenticated users can currently select all profile columns, including status, online state and avatar URL. The staged backend migration `20261114120000_profile_read_privacy_hardening.sql` removes that broad policy, limits direct SELECT to non-sensitive identity columns and grants UPDATE on `username`.

That migration is **not yet applied**. The live database currently lacks authenticated UPDATE privilege on `profiles.username`, which explains why username saves can fail even when the UI appears to change.

Frontend PR #60 (`fix/full-audit-profile-read-privacy-main`) ports the required compatibility work onto current `main`:
- Owner profile reads use `get_my_profile`.
- Conversation participant profiles use `get_conversation_profile_directory`.
- Profile updates no longer request a private full-row SELECT, and verify the saved username via the owner RPC.
- Personal-data export uses the owner RPC.
- Profile loading has loading/error/retry states, stale-response protection and accessible press targets, while retaining the LIVE impact card.

**Required rollout order:** merge/deploy PR #60 first, verify the deployed client, then apply `20261114120000_profile_read_privacy_hardening.sql`. Do not apply the hardening migration before the compatible client is deployed.

## Database and storage security observations

### Warnings that are not demonstrated vulnerabilities

- 36 public tables have RLS enabled but no policies. The inspected set has no `anon` or `authenticated` table grants; these are backend/service-role-only tables, not direct client-readable tables.
- Supabase reports 27 authenticated-executable SECURITY DEFINER functions. The inspected functions have no anon execution grants. Functions without a direct `auth.uid()` reference are narrow wrappers delegating to guarded functions or helpers that enforce the viewer relationship. Their search paths are pinned. No blanket policy or grant changes were made.
- `call_sessions` has broad authenticated UPDATE grants, but its `validate_call_session_write` trigger makes call identity fields immutable and enforces participant-only valid state transitions. `group_room_id` changes are service-role-only.
- `messages` UPDATE is limited to `text` and `edited_at`; `conversation_participants` UPDATE is limited to favorite/mute/archive/read-cursor fields.
- 67 unused indexes are an informational performance finding. They were not dropped without workload evidence.

### Open security/privacy work

1. **Profile visibility (high):** broad authenticated profile SELECT is still active until the staged migration is applied after PR #60 deployment.
2. **Native auth session storage (high):** `supabaseClient.js` uses AsyncStorage for native Supabase auth persistence. Expo distinguishes AsyncStorage from encrypted SecureStore. A secure, migration-safe adapter is still required; it must account for Supabase session payload size and migrate existing sessions without logging users out.
3. **End-to-end encryption (product/security gap):** the live `messages` table stores message bodies in a plaintext `text` column, and the frontend has no Signal/Olm/libsodium-style message-key dependency. Transport encryption and provider-side encryption at rest are not end-to-end encryption. Do not claim E2EE.
4. **Legacy public avatars (medium):** avatar uploads dual-write to `private-avatars` and the public `avatars` bucket for older clients. The private signed-avatar resolver exists, but the current profile/chat read pipeline still returns legacy public avatar URLs. Photo-visibility checks control discovery, but a public URL that has already been shared cannot be revoked by Storage RLS. Complete the client cutover and retire public dual writes/objects in a staged migration.
5. **Leaked-password protection (medium):** Supabase Auth advisor reports leaked-password protection disabled. This is an Auth project setting and was not changed by SQL.
6. **Chat-media MIME policy (medium):** `chat-media` still allows a broad MIME set because the product supports generic file attachments. The 25 MiB server limit is now enforced; consider malware scanning or a narrower allowlist once supported file types are explicitly defined.
7. **Web response headers (medium):** the current Netlify deploy reports no header rules. Add safe anti-sniffing, clickjacking, referrer and permissions headers; evaluate a full CSP against LiveKit, Supabase, OAuth and Expo web requirements before enforcing it.
8. **Replay limits (product constraint):** LIVE replay is capped at 300 seconds, 48,000,000 bytes, 640×360 at 24 fps and 500 kbps video. This is a bounded free-tier design, not a full-length high-resolution broadcast archive.

## Calls, video and LIVE

The recent call/video/LIVE audit and merged fixes cover:
- Direct audio/video lifecycle and symmetric ICE recovery.
- Call-to-conference upgrade and participant invitations.
- Group-call admission and block rechecks.
- Native call end cleanup, heartbeat leases and stale-call cleanup.
- LIVE guest request/approval/token handoff, guest stage lifecycle and participant presence.
- Replay Egress output shape, recovery, stop/cleanup and creator-owned deletion.
- Per-user call-history deletion and creator-owned ended broadcast/replay deletion.

Remaining product/acceptance gaps:
- No screen sharing or picture-in-picture.
- Background/locked-screen media continuity and Bluetooth route behavior still need physical-device verification.
- Web audio output-device selection is not available.
- LIVE reactions are persisted and surfaced through polling; they are not yet a guaranteed sub-second real-time overlay.
- Production replay table currently has no sample row, so a real Egress upload, playback and deletion could not be verified against an actual production replay.

## Release and testing observations

- Frontend main currently deploys to `https://zannychat.netlify.app` at commit `39a37b092bfbeecc7ffd05a436a36f1cfe173018`.
- Render backend is live at commit `79743a676dc504933b9ea0703dfed1d65ddcf7c6`.
- Backend advanced calling CI passed after the storage-limit migration was committed.
- The profile PR's premium frontend quality workflow passed on commit `18d77c5f56fff8da232ce6ca3c90b06af0a7c777`; a follow-up username readback assertion was then added and the latest CI run is still pending.
- Android Kotlin compilation passed on the preceding PR run; APK assembly and iOS/export checks are still required for the latest commit.
- The current Android CI workflow creates a placeholder-Firebase artifact but labels it as physical-device QA. This is misleading and is being corrected separately. A placeholder-Firebase artifact is not evidence of installable production behavior.
- The Android production EAS workflow must remain manual and must not be triggered under the current zero-budget constraint.

## Required acceptance testing before calling the app fully verified

1. Two real accounts: sign-up, verification, sign-in, password reset, profile username/name/status save, sign-out and session restore.
2. Two real accounts: direct chat, message send/edit/delete, read receipts, media upload/download, voice note, attachment retry and deletion.
3. Group: invite/admit/remove members, roles, admin-only messages, blocked-user behavior and group deletion.
4. Status/channel/event/poll flows with different privacy audiences and blocked relationships.
5. Direct audio/video and group calls: accept/decline, audio↔video switch, add participant, speaker/Bluetooth route, background/lock, network interruption/reconnect and history deletion.
6. LIVE: creator broadcast, viewer join, guest request/approval, guest media, comments/reactions, moderation, end, replay recording/playback/deletion.
7. Install the production-configured Android build on a physical Android 10 device and verify cold/warm startup, permissions, notifications and native call lifecycle.
8. Verify profile privacy with an unrelated authenticated account after the profile hardening migration is applied.

## External standards used

- OWASP Mobile Application Security Verification Standard: https://mas.owasp.org/MASVS/
- Expo SecureStore: https://docs.expo.dev/versions/latest/sdk/securestore/
- Expo authentication guidance: https://docs.expo.dev/guides/authentication/

The audit remains open until the profile migration is safely rolled out, the remaining security hardening is addressed, and the real-device/two-account acceptance tests are completed.
