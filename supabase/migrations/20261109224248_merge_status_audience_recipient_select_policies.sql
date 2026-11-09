-- Collapse overlapping SELECT policies while preserving the owner and
-- recipient visibility rules. Keep owner write permissions operation-specific.
BEGIN;

DROP POLICY IF EXISTS "Recipients can identify active statuses shared with them"
  ON public.status_audience_recipients;
DROP POLICY IF EXISTS "Status owner manages audience recipients"
  ON public.status_audience_recipients;

CREATE POLICY "Owners and eligible recipients can read audience recipients"
  ON public.status_audience_recipients
  FOR SELECT
  TO authenticated
  USING (
    owner_id = (SELECT auth.uid())
    OR (
      recipient_id = (SELECT auth.uid())
      AND public.can_view_status(status_id, (SELECT auth.uid()))
    )
  );

CREATE POLICY "Status owners add audience recipients"
  ON public.status_audience_recipients
  FOR INSERT
  TO authenticated
  WITH CHECK (
    owner_id = (SELECT auth.uid())
    AND recipient_id <> (SELECT auth.uid())
    AND EXISTS (
      SELECT 1
      FROM public.status_updates AS s
      WHERE s.id = status_audience_recipients.status_id
        AND s.user_id = (SELECT auth.uid())
        AND s.audience = 'selected_contacts'
    )
    AND EXISTS (
      SELECT 1
      FROM public.conversation_participants AS mine
      JOIN public.conversation_participants AS theirs
        ON theirs.conversation_id = mine.conversation_id
      WHERE mine.user_id = (SELECT auth.uid())
        AND theirs.user_id = status_audience_recipients.recipient_id
    )
  );

CREATE POLICY "Status owners update audience recipients"
  ON public.status_audience_recipients
  FOR UPDATE
  TO authenticated
  USING (owner_id = (SELECT auth.uid()))
  WITH CHECK (
    owner_id = (SELECT auth.uid())
    AND recipient_id <> (SELECT auth.uid())
    AND EXISTS (
      SELECT 1
      FROM public.status_updates AS s
      WHERE s.id = status_audience_recipients.status_id
        AND s.user_id = (SELECT auth.uid())
        AND s.audience = 'selected_contacts'
    )
    AND EXISTS (
      SELECT 1
      FROM public.conversation_participants AS mine
      JOIN public.conversation_participants AS theirs
        ON theirs.conversation_id = mine.conversation_id
      WHERE mine.user_id = (SELECT auth.uid())
        AND theirs.user_id = status_audience_recipients.recipient_id
    )
  );

CREATE POLICY "Status owners delete audience recipients"
  ON public.status_audience_recipients
  FOR DELETE
  TO authenticated
  USING (owner_id = (SELECT auth.uid()));

COMMIT;
