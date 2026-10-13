# ZannyChat backend security patch — 1.1.2 candidate

## Changes
- Link-preview requests now resolve each destination before connecting.
- The HTTP(S) client connects to a validated IP address directly while retaining the URL hostname for the Host header and TLS certificate/SNI checks. This closes the resolve-then-fetch DNS rebinding gap in the prior patch.
- Redirects are followed manually and each hop is resolved and checked independently.
- Added regression cases for local/private IPs and documentation/reserved IPv4 ranges.
- Added one absolute five-second deadline spanning DNS resolution, requests/redirects, and response-body reads; socket inactivity timeouts remain as an additional guard.
- The pinned lookup callback handles Node HTTP clients that request all-address lookup results.
- Existing authentication, rate limiting, redirect cap, response byte cap, and URL credential/protocol checks remain.

## Validation performed here
- `node --check src/routes/linkPreview.js` passed.
- The Jest suite was not run: dependencies are not installed in this workspace.

## Review before deployment
- Install dependencies and run the complete test suite.
- Exercise link previews against public HTTP/HTTPS hosts, redirect chains, slow responses, IPv4/IPv6 literals, and controlled DNS fixtures.
- Verify timeout behavior with controlled slow-DNS and slow-body integration tests; DNS system calls cannot be cancelled, although the route stops waiting at its absolute deadline.
- Do not treat this patch as a substitute for an external security review.
