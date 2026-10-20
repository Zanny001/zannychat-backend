-- Permit users to see their own expired status rows so the app can clean them up.
-- Active-status queries still filter expires_at > now(); contact visibility is unchanged.
drop policy if exists "Status author can read own updates" on public.status_updates;
create policy "Status author can read own updates" on public.status_updates
  for select to authenticated using (user_id = (select auth.uid()));
