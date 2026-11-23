# Apple StoreKit 2 Sparks — release checklist

This integration is intentionally fail-closed. Do not enable Apple purchases or activate an `apple_iap` Sparks package until every production and sandbox acceptance item below has an owner and evidence.

## Server configuration

Render service: `https://zannychat-backend-1.onrender.com`

Required environment variables:

- `LIVE_APPLE_IAP_ENABLED=false` — keep false until all checks pass.
- `APPLE_APP_BUNDLE_ID=com.zannychat.app` — matches the iOS `ios.bundleIdentifier`.
- `APPLE_APP_ID` — numeric App Store app ID from App Store Connect.
- `APPLE_ROOT_CA_CERTIFICATES_BASE64` — comma-separated base64 DER Apple Root CA certificates from the Apple PKI site.
- `APPLE_IAP_ALLOW_SANDBOX=false` — only honored when `NODE_ENV` is not `production`; never turn this on in the production Render service.

The backend uses Apple's official `@apple/app-store-server-library` `SignedDataVerifier`. Keep the Apple root certificates current and verify them from Apple PKI before updating the secret.

## App Store Connect

1. Confirm the app's bundle ID is `com.zannychat.app` and copy its numeric Apple app ID.
2. Create each Sparks product as a **Consumable** In-App Purchase.
3. Make each product ID exactly match its `live_spark_packages.package_id` row for provider `apple_iap`.
4. Configure the Nigeria storefront and NGN price tier. The backend compares Apple's signed milliunit price (converted to kobo) against the server-owned package amount; never accept a client-supplied amount or Sparks quantity.
5. Complete tax, banking, Paid Apps agreement, and any App Store Connect business requirements before submitting products for review.

## App Store Server Notifications V2

Configure both Production and Sandbox notification URLs to:

`https://zannychat-backend-1.onrender.com/webhooks/apple/app-store-server`

Use version 2 only. The backend verifies the outer `signedPayload` and nested `signedTransactionInfo`. It acknowledges verified sandbox notifications without crediting production Sparks. Verified Production REFUND/REVOKE notifications are idempotently reconciled; full refunds revoke unspent purchased Sparks, while partial refunds and accounts with creator payouts are held for manual review.

## Acceptance matrix

- [ ] iOS device/TestFlight connects to StoreKit and loads only active server-catalogue products.
- [ ] Account binding returns a stable UUID and StoreKit echoes it in the signed transaction.
- [ ] A successful Production transaction matches bundle ID, consumable type, product ID, quantity 1, NGN price, account token and purchase date.
- [ ] Sparks are credited once through `fulfill_live_spark_purchase`; duplicate delivery is a replay with no second credit.
- [ ] A transaction bound to another ZannyChat account is rejected.
- [ ] A revoked transaction and an unapproved Sandbox transaction cannot credit Production Sparks.
- [ ] A private PDF receipt is generated and accessible only to its owner through a short-lived signed URL.
- [ ] Production REFUND and REVOKE notifications are verified, deduplicated and reconciled.
- [ ] Partial refunds and creator payout exposure enter the risk hold/manual review path.
- [ ] App Store Server Notifications V2 test notification is received and acknowledged.
- [ ] App Store Connect financial reports are used for actual proceeds and fee reconciliation; signed transaction price is only a package-price check.

## Activation gate

Only after the acceptance matrix passes should an operator:

1. Set `LIVE_APPLE_IAP_ENABLED=true` in Render.
2. Insert or activate the approved `apple_iap` rows in `live_spark_packages` using the exact App Store product IDs, NGN amounts and Sparks quantities.
3. Re-run production smoke checks and verify that the wallet catalogue reports `purchasable=true`.

No product is activated by this code change. Purchases remain unavailable by default.
