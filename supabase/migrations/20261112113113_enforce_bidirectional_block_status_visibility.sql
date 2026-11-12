-- Prevent status disclosure and interactions after either side blocks the other.
-- Keep the owner-self path, expiry, audience, recipient and exclusion rules unchanged.
-- The shared helper protects status rows, private status media, views, reactions,
-- replies and selected-audience recipient visibility.

CREATE OR REPLACE FUNCTION public.can_view_status(p_status_id uuid, p_viewer_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO 'pg_catalog', 'public'
AS $function$
  SELECT COALESCE(
    p_viewer_id = (SELECT auth.uid())
    AND EXISTS (
      SELECT 1
      FROM public.status_updates s
      WHERE s.id = p_status_id
        AND s.expires_at > now()
        AND (
          s.user_id = p_viewer_id
          OR (
            s.user_id <> p_viewer_id
            AND NOT EXISTS (
              SELECT 1
              FROM public.blocked_users b
              WHERE (b.blocker_id = s.user_id AND b.blocked_id = p_viewer_id)
                 OR (b.blocker_id = p_viewer_id AND b.blocked_id = s.user_id)
            )
            AND NOT EXISTS (
              SELECT 1
              FROM public.status_excluded_users x
              WHERE x.owner_id = s.user_id
                AND x.excluded_user_id = p_viewer_id
            )
            AND (
              (
                s.audience = 'contacts'
                AND EXISTS (
                  SELECT 1
                  FROM public.conversation_participants mine
                  JOIN public.conversation_participants theirs
                    ON theirs.conversation_id = mine.conversation_id
                  WHERE mine.user_id = p_viewer_id
                    AND theirs.user_id = s.user_id
                )
              )
              OR (
                s.audience = 'selected_contacts'
                AND EXISTS (
                  SELECT 1
                  FROM public.status_audience_recipients r
                  WHERE r.status_id = s.id
                    AND r.owner_id = s.user_id
                    AND r.recipient_id = p_viewer_id
                )
              )
            )
          )
        )
    ),
    false
  );
$function$;
