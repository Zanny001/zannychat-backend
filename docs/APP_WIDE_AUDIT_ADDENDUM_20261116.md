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
