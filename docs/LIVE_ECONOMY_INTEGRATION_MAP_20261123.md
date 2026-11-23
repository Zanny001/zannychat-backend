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

- **Apple:** App Store Guideline 3.1.1 requires In-App Purchase for in-app digital currency and digital content. StoreKit transaction verification and App Store Server Notifications are the appropriate server connection; Apple's legacy `verifyReceipt` endpoint is deprecated. Purchased credits must not expire, and restore/reconciliation behavior is required. See [App Review Guidelines](https://developer.apple.com/app-store/review/guidelines/), [StoreKit In-App Purchase](https://developer.apple.com/documentation/storekit/in-app-purchase), and [App Store Server Notifications](https://developer.apple.com/documentation/appstoreservernotifications).
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
- Implement Google Play Billing purchase-token verification and Apple StoreKit signed-transaction verification, restore, refund and notification paths before enabling native purchase buttons.
- Configure Paystack live credentials, unified webhook endpoint, webhook signing secret, transfer capability and merchant funding.
- Approve creator share, clearance hours, minimum withdrawal, fee allocation and payout policy.
- Select and implement the creator identity/KYC provider and manual review/appeal operations; do not collect BVN/NIN or identity documents without an approved provider and privacy design.
- Configure and test transfer approval/OTP behavior and a monitored recurring reconciliation mechanism before claiming automatic payout recovery.
- Complete two-account/device acceptance for gift debit/credit, PK scoring, replay/reaction delivery, provider payment verification, refund/dispute holds, payout success/failure/reversal and translation timeout/error behavior.
- Keep automatic microphone transcription clearly out of scope until a speech-to-text provider, consent/retention policy, language coverage, latency and per-minute cost model are selected.

No production payment, payout, price, revenue-share or identity-verification switch is enabled by this audit.
