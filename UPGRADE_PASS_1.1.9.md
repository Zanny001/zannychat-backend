# ZannyChat Upgrade Pass 1.1.9 / 1.2.37

This source-only pass improves real chat-list behavior and production browser-origin controls. It does not deploy to Render, Netlify, or mutate the live Supabase project.

## Changes

- Browser CORS now uses an explicit origin allowlist. The production Netlify app is allowed; extra production origins are configured through `CORS_ORIGINS` (comma-separated). Local Expo web origins are only included outside production. Native and server-to-server requests without an `Origin` header remain supported.
- CORS preflight settings are explicit, and disallowed browser origins receive a generic 403 response.
- Chat-list search now matches contact names, group names, and the last-message preview, and safely handles incomplete conversation metadata.
- Private-media migration 0009 now converts legacy public URLs only when the URL host is this project's Supabase host, in addition to the existing conversation-path check. This prevents URLs from unrelated hosts from being rewritten as trusted private-storage markers.
- Added regression tests for CORS policy and chat-list filtering.

## Verification

- Frontend unit tests: 48 passed.
- Frontend release hygiene audit: 11/11 passed.
- Backend node test suite: 27 passed.

These are local source-level checks. They do not prove production environment settings, deployed migration state, OAuth, email delivery, push delivery, realtime behavior, or device-specific UX.

## Deployment gates

1. Review and deploy the backend CORS configuration. Set `CORS_ORIGINS` to any additional trusted production web origins; do not use `*`.
2. Apply Supabase migration 0009 only if it has not already been applied; do not edit an already-applied migration in production. If migration 0009 has already run, use a new forward-only migration for any required data correction.
3. Build and smoke-test the frontend at the deployed Netlify URL and backend at Render.
4. Continue implementing and validating the larger audit scope (stories/status, channels, calls, linked devices, secret-chat E2EE, bots/mini-apps, and related schema/services) as separate vertical slices. These are not claimed as implemented by this pass.
