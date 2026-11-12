# Phase 6 — Performance and launch-quality audit

Audit date: 2026-11-12  
Scope: read-only production Supabase observations and CI/operational readiness. No production schema, data, or hosting configuration was changed by this audit.

## Database observations

- Supabase database size: approximately 16 MB.
- Observed application sample at audit time: 13 Auth users, 44 messages, 1 channel post, and 3 LIVE streams.
- Supabase performance advisor reported 68 unused indexes.
- This dataset is too small and the database too lightly exercised to infer that these indexes are unnecessary. Many protect foreign keys, privacy lookups, call admission, expiry cleanup, and future workload paths. **Do not drop indexes based on this snapshot.**
- The bidirectional block lookup is covered in both directions: the blocked_users primary key begins with blocker_id; the existing blocked_id index supports the reverse lookup.
- No query-latency distribution or representative production load profile was available. Do not claim a measured query-performance improvement from index removal or speculative tuning.

## Security/performance advisor interpretation

- 29 RLS-enabled tables without policies were previously identified. Read-only privilege inspection found no direct SELECT/INSERT/UPDATE/DELETE grants to anon or authenticated on those tables; these are not automatically client-readable merely because the advisor reports no policies.
- 22 authenticated-executable SECURITY DEFINER functions remain flagged. They have been reviewed as intentional app/RLS helpers; do not blanket-revoke EXECUTE because several are called by RLS policies and application RPCs.
- Leaked-password protection is a paid-plan feature on this project tier; no plan upgrade or paid service was introduced.

## Operational health

The backend exposes:
- `/health/live`: dependency-free process liveness.
- `/health/ready`: bounded database readiness check with 503 when database access is unavailable.
- `/health`: backwards-compatible status endpoint with sanitized diagnostics.

CI now includes dedicated health endpoint and health diagnostic regression suites. Keep platform monitoring pointed at liveness for process restart and use readiness for dependency state; do not expose secrets or raw provider errors in public diagnostics.

## Launch gates still requiring real environments

- Exercise `/health/ready` during a controlled staging database outage and recovery.
- Run real two-account status block/privacy checks in both directions.
- Verify APNs VoIP, APNs alert, and FCM delivery on physical devices.
- Run real Android/iOS voice/video, group-call, creator LIVE, and restrictive-network TURN tests.
- Capture web and native build artifacts and conduct small-screen accessibility/visual review.
- Measure latency and resource usage under representative traffic before considering any index removal or paid infrastructure.

## Decision log

No indexes were removed, no database DDL was added, and no paid monitoring or hosting service was enabled. The next optimization should be driven by real query timings and usage statistics after the app has representative traffic, not by the current low-volume unused-index snapshot.
