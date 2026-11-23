# ZannyChat LIVE monetisation and payouts — operations runbook

Last reviewed: 2026-11-23

## 1. Product currencies and ledgers

ZannyChat must keep these values separate:

- **Sparks** — purchased or awarded virtual currency used to send LIVE gifts. Sparks are not cash, cannot be withdrawn, and have no cash value.
- **Gift points / PK score** — competition points awarded from committed gift transactions. They are not money and do not determine cash earnings.
- **Creator earnings** — NGN-denominated ledger entries created only when a creator or approved stage guest receives a gift funded by purchased Sparks that have actually been spent.
- **Promotional and legacy Sparks** — can be used for gifts and PK scoring, but do not generate creator cash earnings.

Gift spending consumes promotional/support/legacy lots before purchased lots. The spend-allocation ledger records which source funded each gift. All balances and scores are computed server-side.

## 2. Viewer purchase flow

1. The authenticated client fetches the active package catalogue from `GET /live/purchases/packages`.
2. The server owns the package ID, Sparks quantity, NGN price and currency. The client cannot submit a price or Sparks amount.
3. On web, checkout is initialized through `POST /live/purchases/initialize`. The server creates a pending order and a unique Paystack reference.
4. Paystack sends `charge.success` to `POST /webhooks/paystack/live`.
5. The server verifies the raw-body webhook signature, then independently calls Paystack's transaction verification endpoint.
6. The verified reference, order metadata, amount, currency and customer email must match the pending ZannyChat purchase.
7. The exact provider fee is persisted in kobo. The database fulfilment function is idempotent and credits the purchased Sparks lot once only.
8. A browser redirect or a client success callback is never proof of payment.

### Store billing

Sparks are digital currency consumed inside the app:

- **Web:** Paystack checkout is the current provider integration.
- **Android:** Google Play Billing must be integrated and its purchase token verified server-side before mobile Sparks can be credited.
- **iOS:** Apple In-App Purchase / StoreKit must be integrated and the signed transaction verified server-side before mobile Sparks can be credited.

Do not open external Paystack checkout from the native Android or iOS app for Sparks. Do not ship mobile purchase buttons until the corresponding store billing product IDs, server verification, restore/reconciliation and refund handling are implemented.

## 3. Gift and PK flow

1. A sender must be a joined participant in the active LIVE room.
2. A recipient must be an active creator or approved stage guest in that room.
3. The server locks the wallet, validates the catalogue item and available balance, consumes source lots atomically, records the gift transaction and append-only ledger entry.
4. The server derives the active PK battle from the room and recipient. The client cannot choose a battle ID or write a score.
5. The gift score increments the correct battle participant only after the gift transaction commits.
6. Reactions, views, follows, time watched and promotional/legacy Sparks do not create cash earnings.

## 4. Creator earnings calculation

The current calculation foundation:

- Starts from the verified purchased-Sparks value actually spent on gifts.
- Allocates the purchase value proportionally across the purchased Sparks lot.
- Deducts the actual Paystack processing fee verified for that purchase before calculating the creator share.
- Applies a server-managed creator share rule in basis points.
- Places earnings in pending status until the configured clearance timestamp.
- Releases eligible entries to available status when the server evaluates the creator earnings summary or a withdrawal request.
- Holds or reverses earnings only through server-owned accounting operations.

No creator share percentage, clearance period or minimum withdrawal is assumed by the client. The reward-rule table is inactive until the commercial terms are approved and explicitly configured.

## 5. Nigerian bank payout flow

1. Creator eligibility is checked on the server.
2. The client fetches the supported bank list.
3. The creator submits a bank code and 10-digit account number over the authenticated API.
4. The backend resolves the account with Paystack and stores only the Paystack recipient token, bank name, account name and masked last four digits. ZannyChat does not store the full account number, BVN, NIN or identity-document images.
5. The creator selects a verified beneficiary and requests a withdrawal amount in NGN.
6. A database function locks the creator payout account, settles matured earnings, checks identity status, payout hold, verified beneficiary, minimum amount and available ledger balance, then reserves the payout idempotently.
7. The backend initiates a Paystack transfer using a unique transfer reference and the merchant's Paystack balance.
8. `transfer.success`, `transfer.failed` and `transfer.reversed` are verified against Paystack before the payout record is reconciled.

### Payout prerequisites

All of these are required before transfers can be enabled:

- A Paystack business account approved for transfers and funded sufficiently for payouts and provider fees.
- Creator identity/KYC verification and a documented manual-review/appeal process.
- Verified bank beneficiary and account-holder matching rules.
- Approved creator revenue-share terms, clearance period and minimum withdrawal.
- A decision on whether ZannyChat or the creator absorbs transfer fees and applicable statutory levies.
- A configured Paystack transfer-approval setting. Fully automated transfers require the merchant's transfer OTP approval setting to be disabled; this must be an explicit, audited operational decision.
- Transfer webhook URL configured and tested.
- Reconciliation, support, failed-transfer and reversal handling tested.

Paystack's published Nigerian transfer fees and statutory levies can change. Never hardcode them as permanent constants; reconcile actual provider charges and maintain a current fee policy. The server requires `LIVE_PAYOUTS_FEE_POLICY_CONFIGURED=true` before transfers can be submitted.

## 6. Required provider webhooks

Configure these backend URLs in the Paystack dashboard:

- LIVE purchase success: `POST /webhooks/paystack/live`
- Creator payout transfer status: `POST /webhooks/paystack/live-payouts`

The current purchase webhook verifies successful charges and credits orders. The payout webhook verifies transfer success, failure and reversal events.

**Not yet production-ready:** signed refund lifecycle events (`refund.pending`, `refund.processing`, `refund.processed`, `refund.failed`) and chargeback/dispute events (`charge.dispute.create`, `charge.dispute.remind`, `charge.dispute.resolve`) are not yet reconciled into Spark revocations, creator earning holds/reversals and dispute resolution. Until those handlers and tests exist, keep `LIVE_PURCHASES_RISK_WEBHOOKS_READY` unset. Do not activate paid packages.

Webhook handlers must validate signatures over the raw request body, deduplicate repeated events, verify provider state where appropriate, acknowledge only after durable acceptance, and retain an auditable reconciliation record.

## 7. Feature activation gates

### Sparks purchases

All must be true:

- `PAYSTACK_SECRET_KEY` configured securely on the backend.
- `LIVE_PURCHASES_ENABLED=true`.
- `LIVE_PURCHASES_RISK_WEBHOOKS_READY=true` only after refund/dispute lifecycle handling is implemented and verified.
- At least one server-managed Paystack NGN package deliberately activated.
- Paystack dashboard webhook endpoint configured and tested.
- Pricing, customer terms, refund policy, support and reconciliation ready.

### Creator payouts

All must be true:

- `PAYSTACK_SECRET_KEY` configured.
- `LIVE_PAYOUTS_ENABLED=true`.
- `LIVE_PAYOUTS_TRANSFER_OTP_DISABLED=true` only after the merchant setting has been reviewed.
- `LIVE_PAYOUTS_FEE_POLICY_CONFIGURED=true` after transfer fees and statutory levies are accounted for.
- An active creator reward rule with approved share, clearance and minimum withdrawal.
- Creator profile verified and not on payout hold.
- Verified NGN beneficiary.
- Transfer webhook tested and merchant balance funded.

## 8. Current production state and remaining work

The database foundation and API routes are deployed. The following were checked after the foundation migrations:

- No Sparks purchase records.
- No creator earnings records.
- No payout records.
- No active Sparks packages.
- No active creator reward rules.
- No Sparks wallet balances were created by this implementation.

The following are still not complete and must not be represented as live:

- Android Google Play Billing and iOS StoreKit purchase verification.
- Refund and dispute/chargeback webhook reconciliation and earnings reversals.
- A complete creator KYC verification provider/workflow.
- Commercial creator share, clearance and minimum-withdrawal terms.
- Transfer fee/stamp-duty policy and accounting.
- Real two-account gift, PK, purchase, refund and payout end-to-end tests.
- Paystack production onboarding, funded balance and verified webhook delivery.

No production payment, Spark grant, gift send, creator earning or bank transfer should be initiated as a test. Use Paystack test mode and isolated test accounts before any live activation.

## 9. Operational and legal review

Before launch, obtain appropriate Nigerian legal/accounting review for creator agreements, tax reporting/withholding, consumer refunds, dispute handling, age/content safeguards, privacy and record retention. Do not collect BVN, NIN or identity documents directly until a lawful purpose, provider, retention period, access policy and deletion process have been approved.
