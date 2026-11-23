# Apple StoreKit production migration audit

Date: 23 November 2026
Supabase project: `vithpppgyjmazxvogvno`

## Applied migrations

The Supabase migration service applied the following two migrations successfully:

| Production migration version | Migration name | Result |
| --- | --- | --- |
| `20261123161843` | `apple_store_sparks_verification` | Applied |
| `20261123161848` | `apple_store_notifications_refunds` | Applied |

The repository migration filenames are deliberately aligned to those exact production versions:
- `supabase/migrations/20261123161843_apple_store_sparks_verification.sql`
- `supabase/migrations/20261123161848_apple_store_notifications_refunds.sql`

## Read-only post-apply verification

The production SQL verification returned:

| Check | Result |
| --- | --- |
| `live_apple_account_bindings` exists | true |
| `live_apple_server_notifications` exists | true |
| Apple transaction provenance column exists | true |
| RLS enabled on account bindings | true |
| RLS enabled on notification table | true |
| Anonymous read of account bindings | denied |
| Authenticated read of account bindings | denied |
| Service-role read of account bindings | allowed |
| Anonymous execute of Sparks fulfilment RPC | denied |
| Authenticated execute of Sparks fulfilment RPC | denied |
| Service-role execute of Sparks fulfilment RPC | allowed |
| Anonymous execute of Apple refund RPC | denied |
| Authenticated execute of Apple refund RPC | denied |
| Service-role execute of Apple refund RPC | allowed |
| Sparks fulfilment RPC accepts `apple_iap` | true |
| Apple refund reconciliation RPC installed | true |
| Active Apple package count | 0 |
| Active Google Play package count | 0 |

The production package catalogue query returned no package rows at all. No Apple or Google Play purchase is enabled by this migration.

## Safety and remaining gates

- `LIVE_APPLE_IAP_ENABLED` must remain unset or false until App Store Connect setup and device acceptance are complete. The backend requires an explicit true value plus Apple bundle ID, numeric app ID and verified Apple Root CA certificates before it reports Apple checkout as available.
- Production rejects sandbox purchase credit. Sandbox notification JWS is verified and acknowledged without granting production Sparks.
- Do not insert or activate Apple product rows until product IDs, NGN pricing, store agreements, notification URLs and the complete acceptance matrix in `docs/APPLE_STOREKIT_SPARKS_RELEASE_CHECKLIST.md` are verified.
- This audit verifies Supabase schema and database privileges. It does not claim that Render secrets, App Store Connect products, App Store Server Notifications URLs, or an iOS native build have been configured or accepted.
