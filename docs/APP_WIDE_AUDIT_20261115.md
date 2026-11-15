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

1. **Native auth session storage (high):** `main` still persists native Supabase sessions in AsyncStorage. Frontend PR #67 now prepares a chunked SecureStore/Keychain/Android Keystore adapter, migrates old sessions on first read, keeps each value below 1.5 KiB, writes a manifest last, and uses device-only Keychain accessibility. Its seven adapter tests passed locally. The PR is not merged or deployed because it adds a native module; a new Android/iOS binary and physical-device migration test are required first. No EAS build was started under the zero-budget constraint.
2. **Profile visibility (resolved in database; acceptance remains):** a fresh production check confirms `anon` and table-level `authenticated` SELECT are both false on `profiles`; authenticated column SELECT is limited to `id` and `username`, not `avatar_url` or `status`. The current SELECT policy is relationship-scoped, and the owner UPDATE policy remains. Still verify the complete profile/avatar flow using two real accounts on the latest client.
3. **End-to-end encryption (product/security gap):** the live `messages` table stores message bodies in a plaintext `text` column, and the frontend has no Signal/Olm/libsodium-style message-key dependency. Transport encryption and provider-side encryption at rest are not end-to-end encryption. Do not claim E2EE.
4. **Legacy public avatars (medium):** the client now resolves viewer-authorized private avatar URLs and removes public copies when visibility is restricted. Production currently contains three objects in public `avatars` and four in `private-avatars`. The previous profile audit established the three public objects belong to profiles whose profile and photo visibility are both `everyone`. Public avatar dual-write compatibility remains for those public profiles/older clients. Retire public dual writes and objects only after the old-client compatibility window closes; a previously shared public URL cannot be revoked by Storage RLS.
5. **Leaked-password protection (medium):** Supabase Auth advisor reports leaked-password protection disabled. This is an Auth project setting and was not changed by SQL.
6. **Chat-media MIME policy (medium):** `chat-media` still allows a broad MIME set because the product supports generic file attachments. The 25 MiB server limit is now enforced; consider malware scanning or a narrower allowlist once supported file types are explicitly defined.
7. **Web response headers (verified baseline present):** `netlify.toml` already configures `X-Content-Type-Options: nosniff`, `Referrer-Policy: strict-origin-when-cross-origin`, `X-Frame-Options: DENY`, a camera/microphone/geolocation `Permissions-Policy`, a restrictive baseline CSP (`frame-ancestors`, `base-uri`, `object-src`) and HSTS. The audit did not verify the currently published Netlify deploy or its response headers because the Netlify account is not connected in this session. Confirm the published response after the next web export/deploy; evaluate any broader CSP against LiveKit, Supabase, OAuth and Expo web before enforcing it.
8. **Replay limits (product constraint):** LIVE replay is capped at 300 seconds, 48,000,000 bytes, 640×360 at 24 fps and 500 kbps video. This is a bounded free-tier design, not a full-length high-resolution broadcast archive.
9. **PostgreSQL patch level (medium):** production reports PostgreSQL 17.6 on UTF-8/ICU. Supabase's 2026-09-25 release note documents PostgreSQL 17.11 as the security/correctness update containing five security cycles and 44 CVE fixes. `ltree` and `btree_gist` are not installed; no custom operators with non-built-in selectivity estimators were found. `pgcrypto` is installed, but application functions do not reference its PGP encrypt/decrypt routines. Schedule the managed PostgreSQL upgrade with a verified backup and low-traffic window; do not run an unplanned database upgrade during this audit.
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
- Frontend PR #67 prepares SecureStore-backed native auth sessions. Its seven adapter tests passed in an isolated Node 22 harness. It remains open until a native binary containing the module can be built and tested; do not ship the JS change through OTA to existing binaries.
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
