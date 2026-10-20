# Channel post reports — backend 1.2.26

Migration `0037_channel_post_reports.sql` creates an RLS-protected reports table. Authenticated API endpoints allow one report per account/post with reasons limited to spam, harassment, hate, misinformation, and other; optional details are capped at 500 characters. Self-reporting is rejected. Only channel owners and currently subscribed moderators can view open reports and mark them reviewed or dismissed.

Local verification: changed route passes `node --check`; 17 targeted channel regression tests pass. Hosted Supabase migration, concurrent duplicate-report behavior, API integration, and device testing remain outstanding.
