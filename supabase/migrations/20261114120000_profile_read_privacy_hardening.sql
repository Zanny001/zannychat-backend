-- Remove unrestricted profile visibility and direct access to private profile columns.
-- Apply only after the client version using the scoped RPCs is deployed.
BEGIN;

DROP POLICY IF EXISTS "Profiles are viewable by any signed-in user" ON public.profiles;
DROP POLICY IF EXISTS "Users can view own and related profiles" ON public.profiles;

CREATE POLICY "Users can view own and related profiles"
ON public.profiles
FOR SELECT
TO authenticated
USING (
  id = (SELECT auth.uid())
  OR EXISTS (
    SELECT 1
    FROM public.conversation_participants AS viewer_membership
    JOIN public.conversation_participants AS target_membership
      ON target_membership.conversation_id = viewer_membership.conversation_id
    WHERE viewer_membership.user_id = (SELECT auth.uid())
      AND target_membership.user_id = profiles.id
  )
  OR EXISTS (
    -- Historical message senders remain identifiable even if they later
    -- leave a conversation, provided the viewer can still read that thread.
    SELECT 1
    FROM public.messages AS message_row
    JOIN public.conversation_participants AS viewer_membership
      ON viewer_membership.conversation_id = message_row.conversation_id
    WHERE viewer_membership.user_id = (SELECT auth.uid())
      AND message_row.sender_id = profiles.id
  )
  OR EXISTS (
    SELECT 1
    FROM public.call_sessions AS cs
    WHERE (
      (cs.caller_id = (SELECT auth.uid()) AND cs.callee_id = profiles.id)
      OR (cs.callee_id = (SELECT auth.uid()) AND cs.caller_id = profiles.id)
    )
  )
  OR EXISTS (
    -- status_updates RLS itself limits this subquery to active statuses
    -- that this viewer is allowed to see (audience, exclusions and blocks).
    SELECT 1
    FROM public.status_updates AS visible_status
    WHERE visible_status.user_id = profiles.id
  )
);

-- Do not let authenticated clients read private profile columns directly.
-- The app uses owner-only and relationship-scoped SECURITY DEFINER RPCs below
-- for those fields. Keep only the non-sensitive identity projection readable.
REVOKE SELECT ON TABLE public.profiles FROM PUBLIC, anon, authenticated;
REVOKE SELECT (id, name, avatar_color, status, online, created_at, avatar_url, username)
  ON TABLE public.profiles FROM PUBLIC, anon, authenticated;
GRANT SELECT (id, name, username, avatar_color)
  ON TABLE public.profiles TO authenticated;
GRANT UPDATE (username)
  ON TABLE public.profiles TO authenticated;

COMMIT;
