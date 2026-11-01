# ZannyChat backend 1.2.59 — Private phone discovery

- Adds authenticated, rate-limited `/discovery/enrollment` and `/discovery/match` routes.
- Enrollment uses only `req.user.phone` with `phone_confirmed_at` verified by Supabase Auth; clients cannot submit a different enrollment phone.
- Stores only HMAC-SHA256 of normalized E.164 phone values, using a dedicated backend-only `PHONE_DISCOVERY_HMAC_SECRET` (minimum 32 bytes). No plaintext phone field is introduced.
- Matching accepts up to 100 selected phone strings, hashes them in memory, returns public profile fields only, excludes the caller, and sends `Cache-Control: no-store`.
- Migration required: `supabase/migrations/0057_private_phone_discovery.sql`.
- Deployment must set a high-entropy `PHONE_DISCOVERY_HMAC_SECRET` on the backend before enabling the routes. Never put this secret in frontend configuration.
