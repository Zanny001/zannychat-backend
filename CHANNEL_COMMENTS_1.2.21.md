# Channel post comments — backend 1.2.21

Migration `0034_channel_post_comments.sql` adds bounded comments on channel posts. Authenticated API reads include display names; writes require channel subscription (owner is automatically allowed); deletion is restricted to the comment author or channel owner. Database access is mediated by the backend service role with RLS enabled and direct client grants revoked.

Flat comments only; no reply threads, comment reactions, media, reporting, notifications, or live integration test. No live migration or deployment performed.
