# Status realtime publication — backend 1.2.19

Migration `0032_status_updates_realtime.sql` idempotently adds `public.status_updates` to the Supabase realtime publication if it is not already present. It does not change row-level security or grant additional table access. The frontend subscribes while the Status screen is focused, debounces event bursts, refreshes the status list and reaction state, and removes the channel when the screen blurs.

This is source-only. Apply migrations through `0032` in order and validate with two accounts (visible contact, excluded contact, unrelated account, and status owner). Realtime delivery depends on the project's Supabase publication and RLS configuration. No live migration or production deployment was performed.
