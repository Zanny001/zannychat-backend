# Google Play Sparks production configuration checklist

This service verifies Google Play consumable Sparks purchases on the backend. Keep
billing disabled until the complete provider setup and a real license-tester
purchase/refund cycle have passed.

## Render environment

Set these on the backend service only. Never add service-account credentials to
the mobile app, an `EXPO_PUBLIC_*` variable, source control, or build artifacts.

| Variable | Value / source |
| --- | --- |
| `LIVE_GOOGLE_PLAY_BILLING_ENABLED` | Keep `false` until the release gates below pass. |
| `GOOGLE_PLAY_PACKAGE_NAME` | `com.zannychat.app` |
| `GOOGLE_PLAY_SERVICE_ACCOUNT_JSON` | Complete service-account JSON from Google Cloud; store as a Render secret. |
| `GOOGLE_PLAY_PUBSUB_AUDIENCE` | Exact audience configured for the Pub/Sub push subscription's OIDC token. |
| `GOOGLE_PLAY_PUBSUB_SERVICE_ACCOUNT_EMAIL` | Email address of the service account used by Pub/Sub to sign push OIDC tokens. |

The Render blueprint declares these values as secrets or safe disabled defaults.
It does not create Google credentials, grant Play Console access, create products,
or enable billing.

## Google Play Console and Google Cloud

1. Confirm the Android app is registered in Play Console with package name
   `com.zannychat.app`.
2. Create each Sparks item as a consumable one-time product. Record the exact
   product ID and Nigerian price from Play Console; do not invent either value.
3. Confirm the product is available to the Nigeria Play country and that the
   configured price corresponds to the NGN amount entered in ZannyChat's
   inactive catalogue draft (minor units: kobo).
4. Enable the Google Play Developer API in the Google Cloud project.
5. Create a dedicated service account. Grant it only the Play Console app
   permissions needed to read orders and purchases, consume purchases, and
   inspect voided purchases. Link the service account to the correct Play
   Console developer account.
6. Store the complete service-account JSON in Render's
   `GOOGLE_PLAY_SERVICE_ACCOUNT_JSON` secret field. Do not commit it.
7. For refund/void notifications, configure Google Play real-time developer
   notifications to a Pub/Sub topic, then configure an authenticated push
   subscription. Set the exact OIDC audience and signer email in the two
   `GOOGLE_PLAY_PUBSUB_*` variables.

## ZannyChat catalogue

1. An authorised operator creates an inactive `google_play` package draft using
   the exact Play Console product ID, Sparks quantity, NGN price in kobo, and
   display order.
2. Compare the product ID, country availability, and displayed NGN price
   against Play Console before activation.
3. Activate only after the store product is live/available and a test build can
   query it. The backend still refuses to credit a purchase unless Google
   verifies its product ID, completed state, account binding, country, order
   total, and developer proceeds.

## Required release tests

- Purchase succeeds for a registered license tester and credits exactly once.
- A repeated verification of the same purchase token does not credit twice.
- Pending or declined payment does not credit Sparks.
- A token linked to another ZannyChat account is rejected.
- A non-Nigeria purchase and a mismatched product/price are rejected.
- A consumed token cannot be used to create a second credit.
- Refund/void notifications are authenticated and reconcile the matching
  purchase; replayed notifications do not create duplicate reversals.
- The app finalizes/consumes the store transaction only after successful
  backend verification, and purchase history/wallet balances reconcile.

## Enablement rule

Do not set `LIVE_GOOGLE_PLAY_BILLING_ENABLED=true` until all provider setup,
catalogue review, and release tests are complete. Do not enable LIVE creator
payout transfers as part of this work; purchase verification and creator
withdrawals are separate release gates.
