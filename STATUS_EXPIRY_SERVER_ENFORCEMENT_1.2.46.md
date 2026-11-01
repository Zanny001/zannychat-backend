# Backend 1.2.46 — Status expiry enforcement

Migration `0046_server_enforced_status_expiry.sql` enforces supported Status lifetime values (6, 12, 24 or 48 hours), regenerates insert timestamps from database server time, blocks timestamp mutation after insert, and updates Status write policies to support the 48-hour option. Regression tests are in `tests/statusExpiryHardeningMigration.test.cjs`.

The migration is included in source only and has not been applied to production.
