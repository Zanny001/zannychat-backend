# ZannyChat whole-app audit addendum — 2026-11-16

**Status:** In progress. This addendum records fresh repository and production Supabase checks performed on 2026-11-16. It is not a penetration-test certification, a full visual sign-off, or a declaration that all features have passed real-device acceptance.

## Current baseline and scope

- Frontend repository: `Zanny001/zannychat-frontend`; Expo SDK 57, React Native 0.86.3, React 19.2.3.
- Backend repository: `Zanny001/zannychat-backend`; Node service package 1.2.241.
- Supabase project: `vithpppgyjmazxvogvno`, status `ACTIVE_HEALTHY`, region `eu-central-1`, PostgreSQL engine 17.6 (reported build 17.6.1.155).
- Frontend tree: 660 entries; backend tree: 473 entries at audit time.
- Backend route inventory from the previous audit remains 43 root-stack routes plus six tab routes, with Channels reused in both navigators: 48 unique navigation entries. The current premium UI review tracks 46 screen modules. These are different counts; route aliases/reused components should not be redesigned twice.
- Review includes messaging/outbox, authentication/session storage, Supabase grants/RLS/SECURITY DEFINER functions, LIVE/calling, premium UI pull requests, migration ledger and current CI/deployment checks.

## Fresh production Supabase security review

Read-only Supabase advisor and catalog queries at 2026-11-16 16:46 UTC returned:

| Finding | Current result | Assessment |
|---|---:|---|
| RLS-enabled tables with no policies | 37 | INFO. These tables are intentionally service-role/backend-only; a separate grant check is still required before any policy change. Do not add broad policies merely to silence the advisor. |
| SECURITY DEFINER functions executable by authenticated | 28 | WARN requiring authorization review; not proof of a vulnerability by itself. |
| Such functions executable by anon | 0 | Positive. |
| Such functions without a pinned search_path | 0 | Positive. |
| Functions without a direct auth.uid() check | 4 | Reviewed as delegating wrappers: two poll overloads call guarded implementations; the avatar and cover path helpers call privacy-guarded profile functions. Keep this delegation covered by tests. |
| Supabase Auth leaked-password protection | Disabled; not included on Supabase Free | Confirmed platform limitation. Current Supabase pricing lists leaked-password protection as unavailable on the Free plan. With the ₦0 constraint, do not upgrade or enable paid spend just for this feature. Treat it as a documented residual risk; a best-effort Pwned Passwords k-anonymity warning can be evaluated, but it is not equivalent to provider-enforced password screening. |

The contact-directory RPC was inspected directly in production. The only current signature is `public.get_contact_directory(p_user_id uuid DEFAULT NULL)`; it checks `auth.uid()`, shared conversation membership and bidirectional blocks, and returns no avatar URL when photo visibility denies it. It is executable by authenticated/service_role and not anon. The old zero-argument overload is no longer present.

## Confirmed repository/production migration drift

The live migration ledger contains `20261115143129_resolve_contact_directory_rpc_ambiguity`, but the corresponding SQL file was absent from backend `main`. This can create a misleading local/remote migration mismatch even though production already has the corrected single RPC signature.

- Remediation PR: https://github.com/Zanny001/zannychat-backend/pull/112
- Adds the version-matched reconciliation migration to repository history.
- Adds a regression test and includes it in `test:migration-reconciliation`.
- No production SQL is run by this PR; the migration is already recorded as applied in production.
- The first CI pass exposed two test-harness issues (CommonJS module format and over-escaped regular expressions); both were corrected. The latest CI run must pass before merge.

## Messaging and local-data findings

### Existing capabilities

The codebase includes direct/group messaging, message replies/edits/deletion modes, delivery receipts, reactions, drafts, scheduled messages, saved/pinned messages, folders, shared media, attachments, voice notes, retryable outbox and attachment cleanup. Existing outbox safeguards include per-user/per-conversation key isolation, request-ID idempotency, serialized writes, a bounded 50-message queue, timestamp recovery and safe retry diagnostics.

### Outstanding privacy hardening

- `src/services/messageOutbox.js` stores pending message text in AsyncStorage. This is app-private local storage but is not the same protection as Keychain/Keystore encryption. Treat queued text as sensitive local data; design a bounded encrypted persistence migration with safe recovery before changing the storage contract.
- Browser Supabase auth storage uses localStorage when available, with sessionStorage/memory fallback. This preserves reload persistence but makes XSS prevention and a strict CSP important. Do not claim browser tokens are inaccessible to injected same-origin scripts.
- The live `messages.text` column remains plaintext and the frontend does not contain an audited Signal/Olm-style protocol. Transport security, RLS and provider-side encryption at rest are not end-to-end encryption. Do not market ZannyChat as E2EE.
- Test logout/account switching to ensure outbox, drafts, cached media and local previews are scoped to the correct account and cleaned according to retention policy.

## Authentication and session storage

- Native auth now uses the chunked SecureStore adapter when the native module exists, with migration from legacy AsyncStorage. Existing installed binaries that predate the native module still use the legacy fallback until a compatible Android/iOS binary is built and installed.
- Frontend PR #90 is merged: the sign-out revocation marker is now persisted in Keychain/Keystore as well as AsyncStorage, and a regression test simulates reinstalling while Keychain data remains. A new production-configured native binary and real-device sign-in/sign-out/reinstall test remain required.
- No production native build was started in this audit; respect the zero-budget constraint and do not start paid EAS work without separate approval.

## Calling, video and LIVE

- Frontend PR #86 (media lifecycle/role/presence reliability) and PR #89 (Creator Studio and stage role hierarchy) are merged to frontend `main`. Their CI workflows passed and Netlify preview checks were green. Vercel preview checks were blocked by the team's build-rate-limit, not by source tests.
- PR #86/89 merges do not prove remote audio/video delivery. Two-account browser and two-physical-device acceptance remains open.
- PR #84 (direct 1:1 LiveKit transport) remains draft pending real-device/browser audio/video, mute, camera-off continuity, reconnect, termination and conference-promotion QA. The WebRTC fallback must remain available until acceptance is complete.
- Production `live_stream_replays` currently has zero rows in the read-only table summary. A real creator-start → Egress → webhook → private object upload → signed playback → creator deletion cycle is still required.
- LIVE reactions/comments remain persisted and polled rather than guaranteed sub-second realtime overlays.
- No screen sharing or picture-in-picture flow was found in the direct/group call or LIVE screens.
- Background/locked-screen media continuity and Bluetooth routing need physical Android/iOS testing.

## Premium interface work

- Crown Aurora remains the design direction: deep navy/void surfaces, violet signal, cyan presence/thread accent, restrained gold, moderate containers, readable density, and purposeful glass rather than blur on every row.
- PR #91 reapplies the non-conflicting Crown Aurora foundation, shared component, composer, notification, privacy and responsive media changes on current `main`. The old PR #85 LIVE header hunk was intentionally omitted because merged PR #86 already supplies a newer scrollable management rail.
- PR #91 CI and visual acceptance must complete before merge. A source review is not a substitute for screenshots/device checks at narrow Android widths, large text, keyboard-open states, light/dark themes and web viewports.
- Preserve all six primary navigation destinations and service-backed data. Do not ship mock names, fake counts or sample engagement from design references.
- The “36 screens” original scope should be tracked against the verified 48 unique navigation entries / 46 screen modules; route aliases should share one screen QA record.

## Prioritized outstanding actions

### P1 — security/release blockers

1. Record Supabase Free leaked-password protection as a residual platform limitation under the ₦0 constraint; do not upgrade. Consider a separate best-effort k-anonymity password warning, clearly labelled as non-equivalent to provider enforcement.
2. Build/install a production-configured native binary containing SecureStore and validate migration, sign-out, reinstall, token refresh and account switching on Android/iOS.
3. Complete two-account browser and two-device call/LIVE acceptance, including audio routes, reconnect, background/lock, creator/guest/viewer permissions and call teardown.
4. Complete one real LIVE replay Egress-to-playback-to-delete cycle within the verified free-tier quotas; keep recording disabled if plan/remaining quota cannot be confirmed.
5. Reconcile repository migration history via PR #112 after both backend CI workflows pass.
6. Validate web XSS defenses/CSP and remove misleading privacy/E2EE wording.

### P2 — product and reliability

1. Design encrypted bounded outbox persistence and explicit cleanup on sign-out/account deletion; avoid silently dropping queued messages.
2. Complete messaging multi-account acceptance: delivery/read receipts, retry after offline/clock changes, attachments, voice notes, deletion, drafts, folders, saved/pinned and scheduled messages.
3. Continue the screen-by-screen Crown Aurora pass and verify real responsive behavior, touch targets, contrast, keyboard and accessibility.
4. Add authenticated realtime transport for LIVE reactions/comments only after abuse/rate controls and privacy checks are specified.
5. Consider screen sharing and picture-in-picture only after core call reliability is accepted.

### P3 — performance and advanced roadmap

1. Profile startup, memory/battery, media cache and large-history pagination on lower-end Android devices.
2. Review query plans and actual index usage before removing any of the advisor's unused-index notices.
3. Add discovery ranking, scheduled LIVE, polls/PK/supporter features only with real data and moderation controls. Do not introduce wallet/gifts/cash-out until a secure financial ledger and payment verification exist.

## Release status

No frontend production deployment, native binary release or replay recording was triggered by this audit. Netlify preview checks are useful source previews; Vercel build-rate-limit failures are account/plan constraints and must not be misreported as application build failures. Production acceptance remains open until the P1 gates above are completed.


## Storage inventory snapshot — 2026-11-16

A read-only inventory of the live Supabase Storage buckets returned:

| Bucket | Visibility | Objects | Notes |
|---|---|---:|---|
| `avatars` | Public | 3 | All three objects map to profiles whose profile and photo visibility are both `everyone`; this is consistent with the current public-avatar design. |
| `private-avatars` | Private | 4 | One object is referenced by profile data; three objects were unreferenced across `profile_details.avatar_path`, `profile_details.cover_path`, `profiles.avatar_url` and `profile_details.cover_image_url`. These are orphan-cleanup candidates, not automatically safe to delete. |
| `chat-media` | Private | 14 | Private message attachments. |
| `status-media` | Private | 6 | Private status/story media. |
| `live-replays` | Private | 0 | No completed replay object was present at audit time. |

No Storage object was deleted. The three unreferenced private-avatar objects should be rechecked against every application reference and retention rule, backed up if required, then removed through the Supabase Storage API (not direct SQL deletion from `storage.objects`). The public `avatars` bucket should remain limited to profile/photo visibility `everyone`; private profile photos must continue to use the private bucket and authorized signed URLs.


## Security follow-up — 2026-11-16, 18:10 UTC

### Account-local data isolation and deletion cleanup

- Frontend PR #93 is merged to `main` (merge commit `2c77f05f758ec4f145d8cf94fe94b75a11502f07`). It fixes the Status composer draft key that previously had no user identity. Status text, audience mode and selected recipient IDs now use an account-scoped AsyncStorage key; account changes clear in-memory composer state before the next user's draft is loaded.
- The legacy global status-draft key is discarded rather than assigned to the first account that happens to sign in after upgrade. This avoids cross-account disclosure; an unsent legacy draft may be lost once the signed-in Status screen migrates.
- Permanent account deletion now attempts to clear that user's local drafts, pins, pending text outbox, pending attachment outbox, Status draft, and Channel drafts/recent-channel list before local sign-out. The UI reports if local cleanup/sign-out could not be confirmed. Other accounts' prefixed keys are preserved.
- Both frontend quality workflows passed before PR #93 merge. Vercel reported success for the merged main commit; this is a deployment check, not a physical-device acceptance result.

### Message retraction integrity — production fix applied

- Backend PR #116 is merged (merge commit `f11c2b1abbf3f94116403e0f1f23d4d4c725df5f`). Its migration `20261116180000_guard_message_edit_tombstones.sql` is applied to production Supabase project `vithpppgyjmazxvogvno`.
- Root cause: the authenticated message UPDATE policy allowed the sender to update text without requiring `deleted_at IS NULL`. Although the client could not update `deleted_at`, it could restore the text field after the authorized deletion RPC had cleared it, undermining the tombstone.
- The replacement UPDATE policy requires sender ownership, active (non-retracted) state and current conversation membership in both `USING` and `WITH CHECK`. A private invoker trigger provides defence in depth, blocks client-forged edit timestamps and stamps real text edits with the database clock. The existing SECURITY DEFINER deletion RPC remains able to create tombstones.
- Backend quality and advanced-calling backend workflows both passed for the PR head before merge. The live catalog/ACL test passed. Rollback-only authenticated-role tests verified: active edit succeeds and receives a database timestamp; retracted-message edit updates zero rows; a forged future timestamp raises SQLSTATE 42501; the authorised deletion RPC still clears content and writes a tombstone. All test transactions were rolled back; no production message content was changed.

### Rechecked RLS, grants, Storage and privileged functions

- Every public base table checked had RLS enabled. The 37 public tables flagged by the advisor as “RLS enabled, no policy” were checked individually: the `authenticated` role has no SELECT/INSERT/UPDATE/DELETE grants on any of them. They are service-role/internal tables, so the advisor INFO finding is not an authenticated Data API exposure.
- No public table was found with RLS disabled or unexpected `anon` table privileges in the read-only inventory.
- The inspected client-executable SECURITY DEFINER functions had explicit search paths and no `anon` EXECUTE grant. Their generic Supabase advisor warning remains a manual-review reminder, not evidence by itself of a vulnerability; retain the per-function auth.uid()/membership/ownership checks.
- Storage inventory remains: public `avatars` (3 objects, all mapped to profiles whose profile/photo visibility is `everyone`), private `private-avatars` (4 objects), private `chat-media` (14), private `status-media` (6), and private `live-replays` (0). No object was deleted. The 3 unreferenced private-avatar objects remain cleanup candidates only; do not delete them without a full reference/retention review and Storage API deletion.
- Supabase Security Advisor still reports leaked-password protection disabled. The connected project tools do not expose an Auth setting update operation; this remains a dashboard configuration task and must not be described as enabled. Keep the zero-budget constraint; do not upgrade plans or introduce a paid password service without approval.

### Remaining security/release gates

1. Enable Supabase leaked-password protection in Auth settings if available on the current plan; otherwise document the plan limitation and keep stronger password guidance without claiming equivalent HIBP enforcement.
2. Run seeded two-account integration tests for conversation/message read/write, block direction, profile visibility, private avatar/media access, and account deletion. Catalog checks and rollback-only smoke transactions do not replace this suite.
3. Migrate the native auth adapter and account-deletion cleanup to production-configured Android/iOS binaries; test reinstall, account switch, logout and failed-storage scenarios on real devices.
4. Design encrypted, bounded local outbox persistence; current queued message text is account-scoped app storage, not Keychain/Keystore encryption.
5. Do not claim E2EE: messages remain plaintext at the application/database layer and no audited Signal/Olm-style end-to-end protocol is present.
