# ZannyChat whole-app audit — 2026-11-15

**Status:** Deep audit in progress. This report distinguishes verified repository/database findings from workflows that still require physical-device, two-account or external-service acceptance testing. It is not a penetration-test certification. The latest database and GitHub state was rechecked on 2026-11-15.

## Scope inspected

- Frontend screens, navigation-facing modules, API/service layer, native/web startup, profile editing, attachment handling and release workflows.
- Backend routes/jobs, call/video/LIVE fixes, replay Egress, cleanup workers and CI.
- Live Supabase migration ledger, table/column grants, RLS policies, SECURITY DEFINER grants/definitions, storage buckets and object counts.
- Netlify/Render deployment status: not re-verified in this session; the latest frontend `main` commit has not been confirmed exported/deployed, and no Render workspace was selected.
- OWASP MASVS categories: storage, cryptography, authentication/authorization, network, platform, code quality, resilience and privacy.

## Navigation inventory verified against frontend main

The current `src/navigation/AppNavigator.js` contains **43 root-stack routes and 6 bottom-tab routes**. `Channels` appears in both navigators, so the application currently exposes **48 unique navigation entries**, not 36. Several entries reuse one screen component; count them for route/flow QA, but do not duplicate visual redesign work.

- **Authentication (6):** Onboarding, Login, Signup, VerifyEmail, PasswordRecovery, PasswordReset.
- **Messaging and organization (12):** Main, Chats, Chat, NewChat, ForwardMessage, SavedMessages, Drafts, PinnedMessages, ChatFolders, SharedMedia, ChatAppearance, ScheduledMessages.
- **People and groups (6):** PeerProfile, QRContact, ContactDiscovery, CreateGroup, GroupManagement, JoinGroup.
- **Discovery and content (5):** Channels, Polls, Events, Updates, StatusUpdates.
- **Calls (5):** Calls, IncomingCall, OutgoingCall, Call, GroupCall.
- **LIVE (5):** LIVE, LiveHub, LiveStream, LiveReplay, LiveCreatorProfile.
- **Account and settings (9):** Profile, EditProfile, Settings, PrivacySecurity, Notifications, DataStorage, DataExport, Sessions, Help.

The guest/auth route group contains onboarding, login, signup and email verification. Password recovery/reset remain reachable outside the authenticated app group. App routes are gated by `canAccessApp`. Deep-link configuration currently includes PasswordReset, JoinGroup and QRContact. Reused components include Chats/ChatListScreen, Calls/CallHistoryScreen, LIVE/LiveHubScreen, Updates/StatusUpdatesScreen and Channels across both navigators.

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

### Profile privacy and avatar visibility — backend and frontend fixes merged

The profile read-hardening migration and private-avatar visibility cutover are now applied in production Supabase. The frontend compatibility and privacy work was merged in PR #63. Authenticated profile reads now use privacy-scoped RPCs and the client resolves avatar paths through the viewer-authorization RPC; restricted profiles do not fall back to public avatar URLs. Avatar uploads maintain a private copy, public copies are removed when visibility is restricted, and visibility changes use the server-verified `update_my_profile_visibility` RPC.

The username save path verifies persisted values through the owner RPC rather than assuming a successful local UI update means the database write succeeded. A remaining issue is that physical-device/profile acceptance should still verify save, navigate away, reload and confirm persistence under real user sessions.

### Chat media upload security — production fixes merged and applied

The production `chat-media` bucket now has an exact 25 MiB (26,214,400-byte) limit and a supported MIME allowlist. The active-extension guard was corrected so HTML, SVG, script and executable extensions are rejected even when a client labels them as generic binary. Frontend PR #65 validates MIME and actual byte size before upload and avoids retrying permanent validation failures. The frontend picker and service limits match the existing 25 MiB bucket limit.

### LIVE replay diagnostics and cleanup — merged

Backend PR #98 added an authenticated, rate-limited, read-only replay configuration check. It verifies LiveKit Egress and Supabase S3 credentials without starting a recording or returning secret values. Backend PRs #91–#93 corrected chat media extension handling, replay quota release on deletion, newest-first reaction retrieval, and protection against deleting accounts during active calls or LIVE sessions. These changes are merged; the Render deployment status of the replay credential endpoint was not independently re-verified in this session. A real replay Egress → object upload → signed playback → deletion cycle remains an acceptance-test requirement.

## Database and storage security observations

### Warnings that are not demonstrated vulnerabilities

- **37 public tables** have RLS enabled but no policies. A fresh grant check confirmed no `anon` or `authenticated` table SELECT privileges on this set; these are backend/service-role-only tables, not direct client-readable tables.
- The database has **68 SECURITY DEFINER functions**, of which **29 are executable by `authenticated` and zero by `anon`**. All inspected functions have an explicit pinned `search_path`. These require function-by-function authorization review, not blanket revocation. No blanket policy or grant changes were made.
- `call_sessions` has broad authenticated UPDATE grants, but its `validate_call_session_write` trigger makes call identity fields immutable and enforces participant-only valid state transitions. `group_room_id` changes are service-role-only.
- `messages` UPDATE is limited to `text` and `edited_at`; `conversation_participants` UPDATE is limited to favorite/mute/archive/read-cursor fields.
- **66 unused-index notices** are informational performance findings. They were not dropped without workload evidence.

### Open security/privacy work

1. **Native auth session storage (high):** `main` still persists native Supabase sessions in AsyncStorage. Frontend PR #67 now prepares a chunked SecureStore/Keychain/Android Keystore adapter, migrates old sessions on first read, keeps each value below 1.5 KiB, writes a manifest last, and uses device-only Keychain accessibility. Its eight adapter tests passed locally. The PR is not merged or deployed because it adds a native module; a new Android/iOS binary and physical-device migration test are required first. No EAS build was started under the zero-budget constraint.
2. **Profile visibility (resolved in database; acceptance remains):** a fresh production check confirms `anon` and table-level `authenticated` SELECT are both false on `profiles`; authenticated column SELECT is limited to `id` and `username`, not `avatar_url` or `status`. The current SELECT policy is relationship-scoped, and the owner UPDATE policy remains. Still verify the complete profile/avatar flow using two real accounts on the latest client.
3. **End-to-end encryption (product/security gap):** the live `messages` table stores message bodies in a plaintext `text` column, and the frontend has no Signal/Olm/libsodium-style message-key dependency. Transport encryption and provider-side encryption at rest are not end-to-end encryption. Do not claim E2EE.
4. **Legacy public avatars (medium):** the client now resolves viewer-authorized private avatar URLs and removes public copies when visibility is restricted. Production currently contains three objects in public `avatars` and four in `private-avatars`. The previous profile audit established the three public objects belong to profiles whose profile and photo visibility are both `everyone`. Public avatar dual-write compatibility remains for those public profiles/older clients. Retire public dual writes and objects only after the old-client compatibility window closes; a previously shared public URL cannot be revoked by Storage RLS.
5. **Leaked-password protection (medium):** Supabase Auth advisor reports leaked-password protection disabled. This is an Auth project setting and was not changed by SQL.
6. **Chat-media MIME policy (medium):** `chat-media` still allows a broad MIME set because the product supports generic file attachments. The 25 MiB server limit is now enforced; consider malware scanning or a narrower allowlist once supported file types are explicitly defined.
7. **Web response headers (verified baseline present):** `netlify.toml` already configures `X-Content-Type-Options: nosniff`, `Referrer-Policy: strict-origin-when-cross-origin`, `X-Frame-Options: DENY`, a camera/microphone/geolocation `Permissions-Policy`, a restrictive baseline CSP (`frame-ancestors`, `base-uri`, `object-src`) and HSTS. The audit did not verify the currently published Netlify deploy or its response headers because the Netlify account is not connected in this session. Confirm the published response after the next web export/deploy; evaluate any broader CSP against LiveKit, Supabase, OAuth and Expo web before enforcing it.
8. **Replay limits (product constraint):** LIVE replay is capped at 300 seconds, 48,000,000 bytes, 640×360 at 24 fps and 500 kbps video. This is a bounded free-tier design, not a full-length high-resolution broadcast archive.
9. **PostgreSQL patch level (medium):** production reports PostgreSQL 17.6 on UTF-8/ICU. PostgreSQL 17.12 was released on 2026-11-12 and fixes 52 security vulnerabilities plus more than 140 bugs. This makes the managed database patch-level upgrade a priority; schedule it with a verified fresh backup, compatibility checks and a low-traffic maintenance window. Do not perform an unplanned database upgrade during this audit. `ltree` and `btree_gist` are not installed; no custom operators with non-built-in selectivity estimators were found. `pgcrypto` is installed, but application functions do not reference its PGP encrypt/decrypt routines. Schedule the managed PostgreSQL upgrade with a verified backup and low-traffic window; do not run an unplanned database upgrade during this audit.
10. **Supabase CLI v3 transition (maintenance):** the development environment was previously on CLI 2.120.0. Supabase CLI v3 changes hosted/local targeting and command behavior. Pin the current CLI v2 in scripts until the v3 migration is deliberately reviewed; do not silently upgrade production migration workflows.

## Calls, video and LIVE

The recent call/video/LIVE audit and merged fixes cover:
- Direct audio/video lifecycle and symmetric ICE recovery.
- Call-to-conference upgrade and participant invitations.
- Group-call admission and block rechecks.
- Native call end cleanup, heartbeat leases and stale-call cleanup.
- LIVE guest request/approval/token handoff, guest stage lifecycle and participant presence.
- Replay Egress output shape, recovery, stop/cleanup and creator-owned deletion.
- **Completed compatibility modernization:** backend PR #103 migrated replay creation from deprecated `StartRoomCompositeEgress` to unified `StartEgress` and was merged to backend `main` as `c59dac1395f59fcaf12e9bfe7b771d01c45d718f`. The focused Egress unit test passed 8/8 locally, and the full backend LIVE replay regression suite passed in the expanded backend quality workflow. A real production recording/upload/playback/deletion cycle remains outstanding.
- Per-user call-history deletion and creator-owned ended broadcast/replay deletion.

Remaining product/acceptance gaps:
- No screen sharing or picture-in-picture.
- Background/locked-screen media continuity and Bluetooth route behavior still need physical-device verification.
- Web audio output-device selection is not available.
- LIVE reactions are persisted and surfaced through polling; they are not yet a guaranteed sub-second real-time overlay.
- Production `live_stream_replays` currently has **zero rows**, and `live-replays` has **zero objects**. The database has seven historical/live stream rows, but a real Egress → private object upload → signed playback → creator deletion cycle remains unverified.

## Release and testing observations

- Frontend `main` is now at merge commit `03399de036b265bdadba727d3f8ac7a3be73fa00`; PR #66's premium status/LIVE quality and advanced-calling workflows both passed. This merge includes MP4/MOV and HEIC/HEIF/GIF status compatibility.
- The current Netlify published commit was not verified in this session. The latest frontend `main` state must be freshly exported before it can be treated as the live web build.
- The current Render backend deployment commit was not verified in this session; no Render workspace was selected. Do not assume the latest backend `main` documentation or pending PR code is deployed.
- Backend PR #103 was merged after the focused Egress test passed 8/8 in an isolated Node 22 harness. The full `yarn run test:live-replay` suite also passed in the backend quality workflow run triggered by PR #105; the real production recording cycle remains unverified.
- Backend PR #105 expanded the backend regression gates and was merged as `bf3e155d0c598cf55278c4a9e234bb54b24711c4`. Both the Backend quality and Advanced calling backend workflows passed: dependency installation/audit, Jest, health, security, AI input, privacy, media, calls, group calls, LIVE/replay and migration/history suites.
- Frontend PR #67 prepares SecureStore-backed native auth sessions. Its eight adapter tests and ten static account-deletion/OAuth preflight checks passed in isolated Node 22 runs. The latest premium quality workflow passed all 19 steps, including 703/703 unit tests and the integrity suite after its stale OAuth assertion was corrected. The advanced-calling workflow is still building the Android compile-only APK with placeholder Firebase; Kotlin compilation has passed, but packaging and remaining export/tests are not yet complete. PR #67 remains open until the native CI workflow completes; do not ship the JS change through OTA to existing binaries.
- Frontend PR #66 workflows passed `npm run test:unit`, call recovery, native call receiver, release audit, contract audit, integrity tests, Expo web/Android exports, Android/iOS prebuild and Android Kotlin compilation. The Android APK artifact uses placeholder Firebase and is compile-only, not installable for physical-device QA.
- The current Android CI workflow correctly labels its placeholder-Firebase artifact as compile-only and not installable for QA. It is not evidence of production Firebase behavior or physical-device acceptance.
- The Android production EAS workflow must remain manual and must not be triggered under the current zero-budget constraint.

## Required acceptance testing before calling the app fully verified

1. Two real accounts: sign-up, verification, sign-in, password reset, profile username/name/status save, sign-out and session restore.
2. Two real accounts: direct chat, message send/edit/delete, read receipts, media upload/download, voice note, attachment retry and deletion.
3. Group: invite/admit/remove members, roles, admin-only messages, blocked-user behavior and group deletion.
4. Status/channel/event/poll flows with different privacy audiences and blocked relationships.
5. Direct audio/video and group calls: accept/decline, audio↔video switch, add participant, speaker/Bluetooth route, background/lock, network interruption/reconnect and history deletion.
6. LIVE: creator broadcast, viewer join, guest request/approval, guest media, comments/reactions, moderation, end, replay recording/playback/deletion.
7. Install the production-configured Android build on a physical Android 10 device and verify cold/warm startup, permissions, notifications and native call lifecycle.
8. Verify profile privacy with an unrelated authenticated account against the current deployed frontend and database policy.

## External standards and compatibility references

- OWASP Mobile Application Security Verification Standard: https://mas.owasp.org/MASVS/
- Expo SecureStore SDK guidance: https://docs.expo.dev/versions/v57.0.0/sdk/securestore/ (SDK 57 package line; use the SDK-matched release, currently 57.0.4).
- Expo authentication guidance: https://docs.expo.dev/guides/authentication/
- Supabase PostgreSQL 15.19 / 17.11 security and correctness release: https://supabase.com/changelog/postgres-15-19-17-11-breaking-changes
- Supabase CLI v3 migration warning: https://supabase.com/changelog?types=breaking-change
- LiveKit Egress API: https://docs.livekit.io/reference/other/egress/api/

The deprecated Egress API migration and expanded backend quality gates are now in backend `main`. The audit remains open until the SecureStore change is released in a compatible native binary, the remaining security settings and database patch level are addressed, the real replay cycle is verified, and the 48-entry route inventory has passed physical-device/two-account acceptance.

## Follow-up audit updates — 2026-11-15, 12:35 UTC

- **Frontend PR #68 merged:** call history now resolves participant profile details through the privacy-scoped profile directory RPC. Audio redial, video redial and per-user history deletion remain intact.
- **Frontend PR #69 merged:** either participant can remove a deleted-message tombstone from their own chat. The database still restricts global deletion to the sender.
- **Frontend PR #70 merged:** unauthenticated QR-contact, group invitation, LIVE and replay deep links retain an allowlisted continuation through sign-in; temporary web continuation state expires after 30 minutes.
- **Frontend PR #67 remains open:** native auth sessions migrate to chunked SecureStore with a revocation marker that prevents a failed Keychain/Keystore deletion from resurrecting a signed-out session. Google-only account deletion has a provider reauthentication path with same-user ID binding; the backend still enforces fresh auth_time and exact DELETE confirmation.
- **Latest frontend premium quality run:** passed 19/19 steps. npm run test:unit reported 703/703 passing; release/contract checks, Expo web and Android preview exports and test:integrity passed. The integrity workflow initially caught a stale Python assertion for the former OAuth options literal; the test was updated to validate the new web/native redirect helper and optional reauthentication prompt.
- **Latest advanced-calling workflow for PR #67:** npm dependency audit, Expo prebuild and Android Kotlin compilation passed. The Android compile-only APK packaging step is still in progress; its Firebase configuration is deliberately a CI placeholder and the artifact is not suitable for physical-device QA. No EAS production build was started under the zero-budget constraint.
- **Fresh Supabase advisor check:** security advisor still reports the generic authenticated SECURITY DEFINER warning, RLS-enabled/no-policy INFO and leaked-password-protection WARN. Of 68 public SECURITY DEFINER functions, 29 are executable by authenticated and zero by anon; all 68 have pinned search_path. Of the 29 authenticated-executable functions, 24 directly reference auth.uid() and the other five are thin wrappers or visibility helpers that delegate to guarded functions. No blanket grants or RLS changes were made.
- **Fresh Storage review:** chat-media, status-media, private-avatars and live-replays are private buckets; avatars is public by design for public-profile images. Storage object policies restrict chat media to conversation members, status media to authorized status viewers, and private avatar reads to the profile-visibility helper. The replay bucket has no public object policy; playback uses short-lived signed URLs.
- **Fresh performance check:** the advisor reports unused indexes. The current stats snapshot shows 66 public non-unique indexes with zero scans; this is not proof they are unnecessary because the database is low-volume and some indexes support foreign keys, privacy filters or future workload. No index was dropped.
- **Database patch level correction:** production is on PostgreSQL 17.6 while 17.12 is now the latest PostgreSQL 17 minor release. Upgrade remains a managed Supabase operation and has not been started.
- **Deployment boundary:** no frontend web export/deploy or Render production deployment was performed in this follow-up. GitHub merges do not by themselves update the currently published Netlify web bundle or existing Android APKs.

## Hosting deployment verification — 2026-11-15, 12:40 UTC

- **Render backend:** the connected Older's workspace has the production web service zannychat-backend-1 on the backend main branch, Frankfurt region, free plan, auto-deploy enabled. The latest live code deployment succeeded at 2026-11-15 11:45 UTC on backend commit c59dac1395f59fcaf12e9bfe7b771d01c45d718f (the unified LiveKit StartEgress migration). The subsequent backend commit only updates this audit document; no later backend code change is pending deployment.
- **Active Netlify site:** the Older account's zannychat project is the current zannychat.netlify.app production site. Its latest deploy is READY and was published at 2026-11-15 12:12 UTC from frontend commit 27d76827e2259d14e00e2717fd0b8ebc35b63011 (the deleted-message tombstone fix).
- **Frontend production drift:** current frontend main is fb7bcab5b4d60e7df7804629df5a58b148132395. GitHub compare confirms it is two commits ahead of the published zannychat.netlify.app deploy: PR #68's privacy-scoped call-history profile resolution (f994e3f...) and PR #70's protected shared-link continuation (fb7bcab...). Therefore the active web app does not yet contain those two merged fixes.
- **Other Netlify project:** the Primary account's zannychat-app site remains on its 2026-11-14 deploy (6af871f5a4943775f35a0847), and is not the active site selected for this rollout.
- **No deploy was triggered during this audit.** The merged frontend main changes still require a fresh Expo web export before publishing to the Older account's zannychat site. The open PR #67 SecureStore change is a native-module change and must not be treated as a web-only/OTA rollout; it needs a compatible Android/iOS binary.

## LIVE reaction incident — root cause and verification

- Render logs from 2026-11-14 22:36:27 UTC captured POST /live/:streamId/react returning HTTP 503. The adjacent application log identified the cause exactly: `Creators cannot award themselves impact`. The reaction route translated that database exception into a generic 503, so a creator tapping an emoji on their own broadcast saw no successful reaction.
- This was fixed in production migration 20261114224335 (`allow_creator_live_reactions_without_self_impact`, repository migration file 20261114224335_allow_creator_live_reactions_without_self_impact.sql). The RPC now persists the creator's reaction for the on-screen reaction feed, returns current impact totals with score_awarded=false, and does not award the creator supporter points. Viewer reactions still require an active joined participant row and retain the existing anti-abuse impact rules.
- The production Supabase function definition was read back and matches this corrected implementation; the migration ledger confirms the migration is applied. The latest Render code deployment succeeded at 11:45 UTC. A read-only Render log check found no application error logs between 11:45 and 12:40 UTC, but this is not a substitute for a fresh creator/viewer session.
- Added a missing backend regression test in commit e98c8097c9329043630ec234284aec9b345d5cc4. It asserts the creator reaction is inserted before the self-impact branch, no self-impact is awarded, and viewer reactions still require an active joined participant. The applied migration filename has also been reconciled to the production ledger version (20261114224335), avoiding a false pending migration on the next Supabase CLI push. The backend quality and backend tests workflows are now running for the final main commit 4c109ebc3d89714a91c27afae7d964f276d9d132; their results must be checked before considering the test gate complete.
