-- Harden selected-audience recipient-row reads without rewriting migration 0044.
-- Recipient rows are only useful while the status is active and the viewer remains authorized.
drop policy if exists "Recipients can identify statuses shared with them" on public.status_audience_recipients;
drop policy if exists "Recipients can identify active statuses shared with them" on public.status_audience_recipients;
create policy "Recipients can identify active statuses shared with them" on public.status_audience_recipients
  for select to authenticated using (
    recipient_id = (select auth.uid())
    and public.can_view_status(status_id, (select auth.uid()))
  );
