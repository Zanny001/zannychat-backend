# Backend migration release — 1.2.41

Adds `supabase/migrations/0044_selected_status_audiences.sql` for selected-contact Status visibility. Apply after `0043_scheduled_messages.sql`.

The migration creates owner/recipient-scoped RLS on `status_audience_recipients`, extends the `status_updates.audience` check constraint, and introduces `public.can_view_status(uuid, uuid)` to centralize authorization. It updates status row, private media, view receipt, reaction, and reply policies to respect selected recipients and existing owner-wide exclusions.

Before production use, apply the migration to a staging database, run authorization tests with owner / selected recipient / non-recipient / excluded recipient / unrelated account, and verify text, image, and video status visibility plus reactions, replies, and receipts. This release has not been applied to the live Supabase project.
