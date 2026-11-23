# ZannyChat LIVE economy — service and product integration map

Reviewed: 23 November 2026

This document maps the existing production code paths for LIVE gifts, Sparks, PK battles, creator earnings, withdrawals, and translation. It separates working server-owned rules from provider setup and business decisions that are still intentionally gated.

## 1. Screens and navigation

| User experience | Frontend implementation | Service connection |
| --- | --- | --- |
| LIVE stage tools | `src/components/LiveEconomyPanel.js`, embedded by native and web `LiveStreamScreen` | `src/services/liveEconomyService.js` |
| Gift studio and PK arena | LIVE tools panel | Gifts and battles APIs; server-authoritative wallet and battle state |
| Sparks wallet and store | `src/screens/LiveWalletScreen.js` | Wallet, package catalogue, purchase history and receipt APIs |
| Creator earnings | `src/screens/LiveCreatorEarningsScreen.js` | Creator earnings summary and ledger history |
| Withdraw earnings | `src/screens/LiveCreatorPayoutScreen.js` | Eligibility, bank list, beneficiary verification, payout request and history |
| Text translation | LIVE tools panel | Translation status and text-segment translation API |

The screens already exist. The work is to make their service states honest and reliable; duplicate mock screens are not needed.

## 2. API and event connections

All routes below are mounted under the Render backend's authenticated API unless identified as a webhook.

### Gifts and Sparks

- `GET /live/gifts/catalog` — active server-owned gift definitions.
- `GET /live/gifts/wallet` — current Sparks balance and source breakdown.
- `GET /live/gifts/history` — append-only wallet ledger history.
- `GET /live/gifts/stream/:streamId/recent` — recent gifts for the active LIVE.
- `POST /live/gifts/send` — validates and commits a gift through the database function `send_live_gift`.

### PK battles

- `POST /live/battles` — create a challenge for an approved guest already on the same LIVE stage.
- `POST /live/battles/:battleId/accept` and `/decline` — guest response.
- `POST /live/battles/:battleId/start` — host starts the accepted battle.
- `POST /live/battles/:battleId/finish` — host ends the battle.
- `GET /live/battles/stream/:streamId/current` and `GET /live/battles/:battleId` — authoritative state and score.

### Purchases, creator rewards and payouts

- `GET /live/purchases/packages`, `POST /live/purchases/initialize`, `GET /live/purchases/history`, and `GET /live/purchases/:purchaseId/receipt`.
- `GET /live/creator-earnings/summary` and `GET /live/creator-earnings/history`.
- `GET /live/creator-payouts/eligibility`, `/banks`, `/beneficiaries`, `POST /live/creator-payouts/beneficiaries`, `POST /live/creator-payouts/request`, and `GET /live/creator-payouts/history`.

### Provider webhooks

- `POST /webhooks/paystack` is the unified Paystack integration endpoint for purchase fulfilment, refunds/disputes and payout transfer events.
- `POST /webhooks/livekit` receives LiveKit egress lifecycle events for recording/replay processing.
- The older specific Paystack webhook paths remain for compatibility; configure the unified endpoint in the Paystack dashboard.

### LIVE realtime signal

The native and web LIVE screens listen for LiveKit `DataReceived` events containing the server's `feed_changed` invalidation. They refresh gift moments and battle data on invalidation and after reconnection. The panel also has a polling fallback. Gift balances, gift transactions and PK scores are never accepted from a client data packet.

## 3. Server-owned gift and PK rules

The database function `send_live_gift` is the single authoritative transaction boundary. It:

1. Requires an active LIVE stream and a joined sender.
2. Requires the recipient to be an active creator or approved stage guest.
3. Loads the active gift definition and computes Sparks cost and PK points from the catalogue.
4. Locks the sender's wallet and consumes Sparks lots atomically.
5. Records the gift transaction and append-only wallet ledger entry.
6. Allocates purchased-Sparks spend to its originating paid purchase lots.
7. Adds PK score only when the recipient is one of the two participants in an active battle for that stream and the battle is within its start/end window.

The current seeded catalogue is:

| Gift | Cost | PK points |
| --- | ---: | ---: |
| Heart | 1 Spark | 1 |
| Spark | 5 Sparks | 5 |
| Crown | 25 Sparks | 25 |
| Aurora | 100 Sparks | 100 |
| Royal Star | 500 Sparks | 500 |

These are current database definitions, not client constants. The current rule awards the catalogue's `score_points × quantity` to the recipient's side. Reactions, views, follows and watch time do not add PK points.

Sparks lots are spent in this order: promotion/support adjustment, legacy, then purchased. This prevents promotional or legacy credits from being converted into cash creator rewards. The wallet exposes the source breakdown so users can distinguish purchased, promotional and legacy Sparks.

## 4. Purchase and receipt flow

1. The authenticated client requests the active package catalogue.
2. The backend owns package ID, Sparks quantity, price and currency. The client sends only a package ID.
3. On web, the backend creates a pending order and initializes Paystack checkout.
4. Paystack posts `charge.success` to the unified webhook.
5. The backend validates the raw-body webhook signature and independently verifies the transaction with Paystack.
6. It matches the verified reference, purchase metadata, amount, currency and customer email to the pending ZannyChat order.
7. The verified provider fee is persisted. An idempotent database function credits a purchased Sparks lot once only.
8. A deterministic receipt is generated and stored in the private receipt bucket; the owner receives a short-lived signed URL.

A browser redirect or client callback is not proof of payment. Only a server-verified successful transaction can credit Sparks.

## 5. Creator earnings and withdrawal

Creator earnings are separate from Sparks and PK points:

- Only purchased Sparks actually spent on gifts are eligible to generate creator rewards.
- The purchased-Sparks value is allocated proportionally to the originating purchase, after its verified Paystack fee.
- The active server-managed creator reward rule applies its share in basis points and clearance hours.
- Earnings remain pending until their clearance time, then become available through the server's earnings summary/withdrawal path.
- Promotions, support adjustments and legacy Sparks do not create cash earnings.

A withdrawal requires all of the following on the server:

1. A verified creator payout profile with no payout hold.
2. An active creator reward rule and configured minimum withdrawal.
3. A Paystack-verified Nigerian bank beneficiary.
4. Sufficient cleared earnings after existing payout reservations and reversals.
5. Payout feature, fee policy and transfer-approval configuration.
6. A Paystack transfer initiated against a unique reference.
7. A verified `transfer.success`, `transfer.failed` or `transfer.reversed` event before final status is recorded.

The bank account number is sent to Paystack for resolution; ZannyChat retains the provider recipient token, bank/account name and masked last four digits, not the full account number or BVN/NIN.

A safe manual fallback now exists: `yarn run jobs:reconciliation`. It checks at most 100 payouts older than five minutes, verifies each reference/amount/currency with Paystack, and conditionally updates only records still in `requested` or `processing`. This is operator-run, not an automatic scheduler.

## 6. Translation

The current feature is **on-demand text-segment translation**. The viewer/creator types or pastes a segment and chooses a target language. The backend verifies stream participation, validates input and calls the configured Anthropic provider. Provider calls now have a 15-second deadline and propagate cancellation.

Automatic speech recognition, continuous microphone transcription and translated voice audio are not implemented. The screen explicitly discloses this and does not manufacture captions or results when the provider is disabled.

## 7. External provider and store requirements

These are implementation requirements, not optional polish:

- **Apple:** App Store Guideline 3.1.1 requires In-App Purchase for in-app digital currency and digital content. The server implementation now uses Apple's official App Store Server library to verify StoreKit 2 signed transaction JWS and App Store Server Notifications V2; the deprecated `verifyReceipt` endpoint is not used. Production activation remains gated on App Store Connect products, verified Apple Root CA configuration, native device/TestFlight acceptance and explicit catalogue activation. See [App Review Guidelines](https://developer.apple.com/app-store/review/guidelines/), [StoreKit In-App Purchase](https://developer.apple.com/documentation/storekit/in-app-purchase), and [App Store Server Notifications](https://developer.apple.com/documentation/appstoreservernotifications).
- **Google Play:** use Play Billing for digital currency sold in the Android app. Send the purchase token to the secure backend for verification; consumable products must be consumed/acknowledged, and unacknowledged purchases can be refunded after the acknowledgement window. See [Google Play Billing integration](https://developer.android.com/google/play/billing/integrate) and [one-time purchase lifecycle](https://developer.android.com/google/play/billing/lifecycle/one-time).
- **Paystack:** verify successful transactions server-side and fulfil only when the transaction's `data.status` is `success`. Verify webhook signatures on the raw body; the timestamped signature uses a 300-second replay window. See [Verify Payments](https://paystack.com/docs/payments/verify-payments/) and [Webhooks](https://paystack.com/docs/payments/webhooks/).
- **Paystack transfers:** transfers are available to registered businesses in supported countries; the merchant must have enough balance for the transfer plus fees, and recipient details must be verified. See [Transfers](https://paystack.com/docs/transfers/), [How Transfers Work](https://paystack.com/docs/transfers/how-transfers-work/), and [Transfer Recipients](https://paystack.com/docs/transfers/creating-transfer-recipients/).
- **LiveKit:** use server webhooks for room/participant/egress lifecycle and SDK events for live state, reconnection and data messages. A signaling connection alone does not prove media is flowing; verify the media connection and track state. Webhook delivery is retried but not guaranteed. See [LiveKit webhooks and events](https://docs.livekit.io/intro/basics/rooms-participants-tracks/webhooks-events/) and [rooms, participants and tracks](https://docs.livekit.io/intro/basics/rooms-participants-tracks/).

## 8. Production state observed on 23 November 2026

A read-only aggregate query against the production Supabase project returned:

| Gate / record | Current count |
| --- | ---: |
| Active Sparks packages | 0 |
| Active creator reward rules | 0 |
| Purchases / purchased Sparks lots | 0 |
| Gift transactions / wallets | 0 |
| Creator earning entries | 0 |
| Verified payout profiles | 0 |
| Verified payout beneficiaries | 0 |
| Payout records | 0 |
| Purchase risk events | 0 |

The five seeded gift definitions are active. The zero counts mean the production economy is provisioned structurally but has not processed real purchase, gift, earnings or payout activity. Do not activate invented prices, creator percentages, minimum withdrawals or clearance terms.

## 9. Remaining release gates

- Create and approve actual Sparks package SKUs and prices for web.
- Complete the iOS StoreKit client merge, App Store Connect setup, non-production sandbox purchase acceptance and production refund/notification acceptance before enabling native purchase buttons. Google Play server verification and Apple server verification/refund paths are implemented; neither provider has active production packages.
- Configure Paystack live credentials, unified webhook endpoint, webhook signing secret, transfer capability and merchant funding.
- Approve creator share, clearance hours, minimum withdrawal, fee allocation and payout policy.
- Select and implement the creator identity/KYC provider and manual review/appeal operations; do not collect BVN/NIN or identity documents without an approved provider and privacy design.
- Configure and test transfer approval/OTP behavior and a monitored recurring reconciliation mechanism before claiming automatic payout recovery.
- Complete two-account/device acceptance for gift debit/credit, PK scoring, replay/reaction delivery, provider payment verification, refund/dispute holds, payout success/failure/reversal and translation timeout/error behavior.
- Keep automatic microphone transcription clearly out of scope until a speech-to-text provider, consent/retention policy, language coverage, latency and per-minute cost model are selected.

No production payment, payout, price, revenue-share or identity-verification switch is enabled by this audit.


## Native Google Play Sparks purchase lifecycle (2026-11-23 follow-up)

The Android wallet now has a native Google Play Billing adapter. It does not use Paystack checkout on Android.

1. The wallet requests `GET /live/purchases/packages?provider=google_play`. The backend returns only active NGN packages from `live_spark_packages`, and reports purchases as available only when the protected Google Play provider configuration is enabled.
2. The wallet requests `GET /live/purchases/native/account-binding`. The authenticated backend returns SHA-256 of the current Supabase user ID as the Google Play obfuscated account identifier. The app sends this identifier in the Google Play Billing request.
3. After a completed store purchase, the app sends the product ID and purchase token to `POST /live/purchases/native/verify`.
4. The backend verifies the purchase token with Google Play Developer API, requires the correct product, completed state, Nigeria Play region and account binding, then verifies the order, exact product line item, buyer-paid amount and developer proceeds. Sparks quantity and configured package price are never accepted from the client.
5. The backend records the verified order ID, gross amount and provider fee, then calls the service-role-only `fulfill_live_spark_purchase` RPC. The RPC atomically credits the wallet, creates the purchased Sparks lot and writes the ledger.
6. The backend generates the existing private PDF receipt. Only after the API reports successful credit does the Android client finish/consume the Google Play consumable. Unfinished purchases are recovered and reverified on wallet entry; the server fulfilment is idempotent.
7. Google Play RTDN is delivered through authenticated Pub/Sub push to `/webhooks/google-play`. The backend verifies Google's OIDC JWT (issuer, rotating signing key, audience, email and expiry), then cross-checks a voided notification against the Google Voided Purchases API before revoking unspent Sparks.
8. Full voids revoke remaining purchased Sparks and hold related unpaid creator earnings. Partial refunds and cases where creator earnings were already paid are left for operator review; the system does not silently invent a negative wallet or reverse a completed payout.

### Required Google/Render configuration (not enabled)

- `LIVE_GOOGLE_PLAY_BILLING_ENABLED=true`
- Protected `GOOGLE_PLAY_SERVICE_ACCOUNT_JSON`, with Android Publisher access and the financial-report permission required by the Voided Purchases API
- `GOOGLE_PLAY_PACKAGE_NAME=com.zannychat.app`
- `GOOGLE_PLAY_PUBSUB_AUDIENCE` equal to the exact configured push audience
- `GOOGLE_PLAY_PUBSUB_SERVICE_ACCOUNT_EMAIL` equal to the Pub/Sub push authentication service account
- Play Console one-time product IDs and regional NGN prices matching explicitly activated `google_play` rows in `live_spark_packages`
- Pub/Sub topic/subscription configured for one-time product and voided-purchase RTDNs

No package is active and no billing flag or provider secret is enabled by this implementation. The frontend requires a new native Android build. The iOS StoreKit client is tracked separately in frontend PR #385; the Apple backend and production database foundation are in place, but production billing remains disabled.

Official implementation references:
- Google Play one-time purchase lifecycle: https://developer.android.com/google/play/billing/lifecycle/one-time
- Google Play RTDN reference: https://developer.android.com/google/play/billing/rtdn-reference
- Google Play Voided Purchases API: https://developers.google.com/android-publisher/api-ref/rest/v3/purchases.voidedpurchases
- Google Pub/Sub authenticated push: https://cloud.google.com/pubsub/docs/authenticate-push-subscriptions


## Native Apple StoreKit 2 Sparks purchase lifecycle (2026-11-23 follow-up)

The backend StoreKit 2 implementation is merged in backend PR #230. Its two migrations are applied to production (Supabase migration versions `20261123161843` and `20261123161848`). The iOS client is tracked in frontend PR #385 and must be merged and accepted on a native build before release.

1. The wallet requests `GET /live/purchases/packages?provider=apple_iap`. The backend returns only active NGN packages and reports purchases as available only when the Apple provider is explicitly enabled and fully configured.
2. The authenticated client requests `GET /live/purchases/apple/account-binding`. The backend returns a stable random UUID `appAccountToken` stored in the service-role-only `live_apple_account_bindings` table. The raw ZannyChat user ID is never sent to Apple as the token.
3. StoreKit 2 starts a single-quantity consumable purchase using that `appAccountToken`. The client submits the signed transaction JWS to `POST /live/purchases/apple/verify`; client-supplied price and Sparks quantity are not accepted.
4. The backend verifies the JWS with Apple's official `@apple/app-store-server-library` `SignedDataVerifier` and configured Apple Root CA certificates. It checks the app bundle, consumable product type, account token, transaction identity, quantity, revocation state, purchase date, active server package and exact NGN price.
5. A service-role-only idempotent `fulfill_live_spark_purchase` RPC credits the purchased Sparks lot once. The existing private PDF receipt service creates the receipt. The iOS client finishes the StoreKit consumable only after the backend confirms fulfilment.
6. App Store Server Notifications V2 are received at `POST /webhooks/apple/app-store-server`. The backend verifies the outer signed payload and nested signed transaction, deduplicates by Apple's notification UUID, and reconciles REFUND/REVOKE events through the service-role-only `record_live_apple_refund` function.
7. Full refunds revoke remaining purchased Sparks and hold related unpaid creator earnings. Partial refunds and accounts with requested, processing or paid creator payouts are held for manual reconciliation. A verified sandbox notification is acknowledged but never credits production Sparks.
8. Sandbox purchase fulfilment is allowed only when `NODE_ENV` is not `production` and `APPLE_IAP_ALLOW_SANDBOX=true`. The production backend rejects sandbox purchase credit.

### Required Apple / Render configuration (not enabled)

- `LIVE_APPLE_IAP_ENABLED=true` only after the release gate passes.
- `APPLE_APP_BUNDLE_ID=com.zannychat.app`.
- `APPLE_APP_ID` set to the numeric App Store app ID.
- `APPLE_ROOT_CA_CERTIFICATES_BASE64` set to comma-separated base64 DER Apple Root CA certificates.
- `APPLE_IAP_ALLOW_SANDBOX=false` in production.
- App Store Connect consumable product IDs must exactly match `apple_iap` rows in `live_spark_packages`, with approved Nigeria NGN price tiers.
- Production and Sandbox App Store Server Notifications V2 URLs must point to `https://zannychat-backend-1.onrender.com/webhooks/apple/app-store-server`.
- Complete App Store Connect agreements, tax and banking setup, then perform a non-production sandbox purchase, duplicate notification, account mismatch, refund and notification retry acceptance before production activation.

No Apple package is active. The production package table currently has zero rows for both Apple and Google Play; the code and migrations do not activate store purchases.
