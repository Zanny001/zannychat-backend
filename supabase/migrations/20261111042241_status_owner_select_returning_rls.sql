-- Allow status authors to read their own active rows immediately.
-- This is required for INSERT ... RETURNING in create_status_update:
-- can_view_status() is STABLE and cannot see the row inserted by the
-- same statement. Other viewers remain subject to audience authorization.
DROP POLICY IF EXISTS "Authorized viewers can read active statuses"
  ON public.status_updates;

CREATE POLICY "Authorized viewers can read active statuses"
  ON public.status_updates
  FOR SELECT
  TO authenticated
  USING (
    expires_at > now()
    AND (
      user_id = (SELECT auth.uid())
      OR public.can_view_status(id, (SELECT auth.uid()))
    )
  );
