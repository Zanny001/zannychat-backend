# ZannyChat backend security patch — 1.1.3 candidate

## Changes
- Pins outbound link-preview connections to the exact IP address validated by DNS, while preserving the original hostname for the HTTP Host header and TLS certificate/SNI checks.
- Manually follows redirects and validates every redirect destination before connecting.
- Enforces an absolute five-second deadline across DNS waiting, all redirect requests, and response-body reads; socket inactivity timeout is an additional guard.
- Handles Node lookup callbacks that request all-address results.
- Tightens IPv6 filtering to globally allocated unicast space and rejects documentation, transition, and special-purpose ranges, including expanded/zero-padded IPv6 spellings and IPv4-mapped private addresses.
- Adds deadline regression tests and expanded IPv4/IPv6 blocklist cases.

## Validation performed in this workspace
- `node --check src/routes/linkPreview.js` passed.
- `node --check tests/linkPreview.test.js` passed.
- Standalone smoke checks passed for 20 blocked IP examples, 4 public IP examples, and deadline success/timeout/expired-deadline behavior.
- Full Jest suite could not be run: dependencies were not installed, and `npm install --ignore-scripts --no-audit --no-fund --no-package-lock` timed out.
- No live network integration tests or deployment were performed.

## Release gates before deployment
1. Install dependencies in a network-enabled environment and run `npm test`.
2. Add/run controlled HTTP and HTTPS integration tests for pinned DNS, redirects to private IPs, slow headers/body, and IPv4/IPv6 destinations.
3. Review DNS timeout behavior in the deployment runtime; Node's system DNS lookup cannot itself be cancelled, although the route stops waiting at its absolute deadline.
4. Apply database migrations only after validating them against a disposable Supabase project and running RLS tests.
5. Keep the current live service unchanged until all release gates pass.
