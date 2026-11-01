# Backend migration patch 1.2.69

- Adds `0064_reconcile_legacy_0046_status_expiry.sql` to repair the historical migration version collision between legacy `0046_channel_post_idempotency.sql` and canonical `0046_server_enforced_status_expiry.sql`.
- Leaves migrations `0001`–`0063` unchanged.
- Includes a static regression test for migration ordering and the compatibility behavior.
- Does not imply that SQL has been applied to any hosted Supabase project.
