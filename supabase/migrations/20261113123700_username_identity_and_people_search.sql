-- Complete username identity for email and Google Auth, plus privacy-aware
-- server-side member search. Existing profiles are backfilled before the
-- username column becomes mandatory. The auth.users trigger itself is preserved.
BEGIN;

ALTER TABLE public.profiles
  ADD COLUMN IF NOT EXISTS username text;

CREATE UNIQUE INDEX IF NOT EXISTS profiles_username_lower_unique
  ON public.profiles (lower(username))
  WHERE username IS NOT NULL AND btrim(username) <> '';

-- Support bounded prefix searches without a full table scan as the directory grows.
CREATE INDEX IF NOT EXISTS profiles_username_prefix_idx
  ON public.profiles (lower(username) text_pattern_ops);
CREATE INDEX IF NOT EXISTS profiles_name_prefix_idx
  ON public.profiles (lower(name) text_pattern_ops);

-- Backfill every existing account with a readable display-name-derived
-- username. Numeric suffixes are added only when a name is already taken.
DO $backfill$
DECLARE
  v_profile record;
  v_base text;
  v_username text;
  v_attempt integer;
BEGIN
  FOR v_profile IN
    SELECT p.id, p.name, u.email
    FROM public.profiles AS p
    LEFT JOIN auth.users AS u ON u.id = p.id
    WHERE p.username IS NULL OR btrim(p.username) = ''
    ORDER BY p.created_at, p.id
  LOOP
    v_base := pg_catalog.regexp_replace(
      pg_catalog.lower(
        COALESCE(
          NULLIF(pg_catalog.btrim(v_profile.name), ''),
          NULLIF(pg_catalog.split_part(COALESCE(v_profile.email, ''), '@', 1), ''),
          'zannyuser'
        )
      ),
      '[^a-z0-9]',
      '',
      'g'
    );
    IF pg_catalog.length(v_base) < 3 THEN
      v_base := 'zannyuser';
    END IF;
    v_base := pg_catalog.left(v_base, 24);
    v_attempt := 0;

    LOOP
      v_username := CASE
        WHEN v_attempt = 0 THEN v_base
        ELSE pg_catalog.left(v_base, 24 - pg_catalog.length(v_attempt::text)) || v_attempt::text
      END;
      BEGIN
        UPDATE public.profiles
        SET username = v_username
        WHERE id = v_profile.id
          AND (username IS NULL OR btrim(username) = '');
        EXIT;
      EXCEPTION WHEN unique_violation THEN
        v_attempt := v_attempt + 1;
        IF v_attempt >= 999999 THEN
          RAISE EXCEPTION 'Could not allocate a unique username for profile %', v_profile.id;
        END IF;
      END;
    END LOOP;
  END LOOP;
END;
$backfill$;

ALTER TABLE public.profiles
  ALTER COLUMN username SET NOT NULL;

ALTER TABLE public.profiles
  DROP CONSTRAINT IF EXISTS profiles_username_format_check;

ALTER TABLE public.profiles
  ADD CONSTRAINT profiles_username_format_check
  CHECK (username ~ '^[a-z0-9_]{3,24}$');

-- New Supabase Auth users (email/password and every OAuth provider, including
-- Google) pass through this existing trigger. Keep its trigger attachment;
-- only replace its function body. Never trust provider metadata for authz.
CREATE OR REPLACE FUNCTION public.handle_new_user()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $function$
DECLARE
  v_name text;
  v_base text;
  v_username text;
  v_attempt integer := 0;
BEGIN
  v_name := COALESCE(
    NULLIF(pg_catalog.btrim(NEW.raw_user_meta_data ->> 'name'), ''),
    NULLIF(pg_catalog.btrim(NEW.raw_user_meta_data ->> 'full_name'), ''),
    NULLIF(pg_catalog.btrim(NEW.raw_user_meta_data ->> 'display_name'), ''),
    NULLIF(
      pg_catalog.btrim(
        COALESCE(NEW.raw_user_meta_data ->> 'given_name', '') || ' ' ||
        COALESCE(NEW.raw_user_meta_data ->> 'family_name', '')
      ),
      ''
    ),
    NULLIF(pg_catalog.split_part(COALESCE(NEW.email, ''), '@', 1), ''),
    'ZannyChat member'
  );

  v_base := pg_catalog.regexp_replace(pg_catalog.lower(v_name), '[^a-z0-9]', '', 'g');
  IF pg_catalog.length(v_base) < 3 THEN
    v_base := 'zannyuser';
  END IF;
  v_base := pg_catalog.left(v_base, 24);

  LOOP
    v_username := CASE
      WHEN v_attempt = 0 THEN v_base
      ELSE pg_catalog.left(v_base, 24 - pg_catalog.length(v_attempt::text)) || v_attempt::text
    END;
    BEGIN
      INSERT INTO public.profiles (id, name, username)
      VALUES (NEW.id, v_name, v_username)
      ON CONFLICT (id) DO UPDATE
        SET name = CASE
              WHEN NULLIF(pg_catalog.btrim(public.profiles.name), '') IS NULL
                THEN EXCLUDED.name
              ELSE public.profiles.name
            END,
            username = COALESCE(
              NULLIF(public.profiles.username, ''),
              EXCLUDED.username
            );
      RETURN NEW;
    EXCEPTION WHEN unique_violation THEN
      v_attempt := v_attempt + 1;
      IF v_attempt >= 999999 THEN
        RAISE EXCEPTION 'Could not allocate a unique username for auth user %', NEW.id;
      END IF;
    END;
  END LOOP;
END;
$function$;

REVOKE ALL ON FUNCTION public.handle_new_user() FROM PUBLIC, anon, authenticated;

-- The previous policy exposed every profile row to every authenticated
-- account, bypassing the profile-visibility and block checks in directory RPCs.
-- Keep direct row reads only for the signed-in user and existing relationships;
-- discoverable strangers must go through the filtered search/profile RPCs.
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

-- Full profile fields are available only to the signed-in owner.
CREATE OR REPLACE FUNCTION public.get_my_profile()
RETURNS TABLE (
  id uuid,
  name text,
  avatar_color text,
  avatar_url text,
  status text,
  online boolean,
  created_at timestamptz,
  username text
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $function$
  SELECT p.id, p.name, p.avatar_color, p.avatar_url, p.status, p.online, p.created_at, p.username
  FROM public.profiles AS p
  WHERE p.id = auth.uid();
$function$;

REVOKE ALL ON FUNCTION public.get_my_profile() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_my_profile() TO authenticated;
COMMENT ON FUNCTION public.get_my_profile() IS
  'Returns the complete profile row only for the authenticated owner.';

-- Existing chat participants need display fields, but private avatar and
-- presence preferences must still be applied. This RPC is limited to IDs the
-- caller supplies AND shares a conversation with.
CREATE OR REPLACE FUNCTION public.get_conversation_profile_directory(p_user_ids uuid[])
RETURNS TABLE (
  id uuid,
  name text,
  username text,
  avatar_color text,
  avatar_url text,
  status text,
  online boolean
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $function$
DECLARE
  v_viewer uuid := auth.uid();
BEGIN
  IF v_viewer IS NULL THEN
    RAISE EXCEPTION 'Authentication required' USING ERRCODE = '42501';
  END IF;
  IF COALESCE(pg_catalog.cardinality(p_user_ids), 0) > 500 THEN
    RAISE EXCEPTION 'Too many profile IDs requested' USING ERRCODE = '22023';
  END IF;

  RETURN QUERY
  SELECT
    p.id,
    p.name,
    p.username,
    p.avatar_color,
    CASE
      WHEN COALESCE(d.photo_visibility, 'everyone') = 'nobody'
        OR EXISTS (
          SELECT 1 FROM public.blocked_users AS b
          WHERE (b.blocker_id = v_viewer AND b.blocked_id = p.id)
             OR (b.blocker_id = p.id AND b.blocked_id = v_viewer)
        ) THEN NULL
      ELSE p.avatar_url
    END AS avatar_url,
    p.status,
    CASE
      WHEN COALESCE(d.show_online_status, true)
        AND NOT EXISTS (
          SELECT 1 FROM public.blocked_users AS b
          WHERE (b.blocker_id = v_viewer AND b.blocked_id = p.id)
             OR (b.blocker_id = p.id AND b.blocked_id = v_viewer)
        ) THEN p.online
      ELSE false
    END AS online
  FROM public.profiles AS p
  LEFT JOIN public.profile_details AS d ON d.user_id = p.id
  WHERE p.id <> v_viewer
    AND p.id = ANY(COALESCE(p_user_ids, ARRAY[]::uuid[]))
    AND EXISTS (
      SELECT 1
      FROM public.conversation_participants AS mine
      JOIN public.conversation_participants AS theirs
        ON theirs.conversation_id = mine.conversation_id
      WHERE mine.user_id = v_viewer
        AND theirs.user_id = p.id
    );
END;
$function$;

REVOKE ALL ON FUNCTION public.get_conversation_profile_directory(uuid[]) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_conversation_profile_directory(uuid[]) TO authenticated;
COMMENT ON FUNCTION public.get_conversation_profile_directory(uuid[]) IS
  'Returns privacy-filtered profile fields only for the caller and requested users who share a conversation.';

-- Search quotas are stored separately from phone-discovery quotas. No client
-- role can inspect or mutate this internal table directly.
CREATE TABLE IF NOT EXISTS public.people_search_limits (
  user_id uuid PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  window_started_at timestamptz NOT NULL,
  request_count integer NOT NULL CHECK (request_count >= 0)
);
ALTER TABLE public.people_search_limits ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.people_search_limits FROM PUBLIC, anon, authenticated;

-- Search only the public identity projection. Profile visibility, photo
-- visibility, shared-conversation contact scope, bidirectional blocks, and a
-- persistent per-user quota are enforced inside this SECURITY DEFINER RPC.
CREATE OR REPLACE FUNCTION public.search_people(
  p_query text,
  p_limit integer DEFAULT 20
)
RETURNS TABLE (
  id uuid,
  name text,
  username text,
  avatar_color text,
  avatar_url text
)
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = ''
AS $function$
DECLARE
  v_viewer uuid := auth.uid();
  v_query text;
  v_pattern text;
  v_window timestamptz := pg_catalog.date_trunc('minute', pg_catalog.clock_timestamp());
  v_request_count integer;
BEGIN
  IF v_viewer IS NULL THEN
    RAISE EXCEPTION 'Authentication required' USING ERRCODE = '42501';
  END IF;

  v_query := pg_catalog.lower(pg_catalog.btrim(COALESCE(p_query, '')));
  IF pg_catalog.left(v_query, 1) = '@' THEN
    v_query := pg_catalog.substr(v_query, 2);
  END IF;
  IF pg_catalog.length(v_query) < 2 OR pg_catalog.length(v_query) > 40 THEN
    RETURN;
  END IF;

  -- Escape LIKE metacharacters so input is always a literal prefix.
  v_pattern := pg_catalog.replace(
    pg_catalog.replace(
      pg_catalog.replace(v_query, E'\\', E'\\\\'),
      '%',
      E'\\%'
    ),
    '_',
    E'\\_'
  ) || '%';

  INSERT INTO public.people_search_limits (user_id, window_started_at, request_count)
  VALUES (v_viewer, v_window, 1)
  ON CONFLICT (user_id) DO UPDATE
    SET window_started_at = CASE
          WHEN public.people_search_limits.window_started_at < v_window THEN v_window
          ELSE public.people_search_limits.window_started_at
        END,
        request_count = CASE
          WHEN public.people_search_limits.window_started_at < v_window THEN 1
          ELSE public.people_search_limits.request_count + 1
        END
  RETURNING request_count INTO v_request_count;

  IF v_request_count > 30 THEN
    RAISE EXCEPTION 'People search rate limit exceeded' USING ERRCODE = '42900';
  END IF;

  RETURN QUERY
  SELECT
    p.id,
    p.name,
    p.username,
    p.avatar_color,
    CASE
      WHEN COALESCE(d.photo_visibility, 'everyone') = 'nobody' THEN NULL
      WHEN COALESCE(d.photo_visibility, 'everyone') = 'contacts'
        AND NOT EXISTS (
          SELECT 1
          FROM public.conversation_participants AS mine
          JOIN public.conversation_participants AS theirs
            ON theirs.conversation_id = mine.conversation_id
          WHERE mine.user_id = v_viewer
            AND theirs.user_id = p.id
        ) THEN NULL
      ELSE p.avatar_url
    END AS avatar_url
  FROM public.profiles AS p
  LEFT JOIN public.profile_details AS d ON d.user_id = p.id
  WHERE p.id <> v_viewer
    AND (
      pg_catalog.lower(p.username) LIKE v_pattern ESCAPE E'\\'
      OR pg_catalog.lower(p.name) LIKE v_pattern ESCAPE E'\\'
    )
    AND COALESCE(d.profile_visibility, 'everyone') <> 'nobody'
    AND (
      COALESCE(d.profile_visibility, 'everyone') = 'everyone'
      OR (
        COALESCE(d.profile_visibility, 'everyone') = 'contacts'
        AND EXISTS (
          SELECT 1
          FROM public.conversation_participants AS mine
          JOIN public.conversation_participants AS theirs
            ON theirs.conversation_id = mine.conversation_id
          WHERE mine.user_id = v_viewer
            AND theirs.user_id = p.id
        )
      )
    )
    AND NOT EXISTS (
      SELECT 1
      FROM public.blocked_users AS b
      WHERE (b.blocker_id = v_viewer AND b.blocked_id = p.id)
         OR (b.blocker_id = p.id AND b.blocked_id = v_viewer)
    )
  ORDER BY
    CASE
      WHEN pg_catalog.lower(p.username) = v_query THEN 0
      WHEN pg_catalog.lower(p.username) LIKE v_pattern ESCAPE E'\\' THEN 1
      ELSE 2
    END,
    pg_catalog.lower(p.name),
    p.id
  LIMIT GREATEST(1, LEAST(COALESCE(p_limit, 20), 25));
END;
$function$;

REVOKE ALL ON FUNCTION public.search_people(text, integer) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.search_people(text, integer) TO authenticated;
COMMENT ON FUNCTION public.search_people(text, integer) IS
  'Prefix-searches discoverable public identities only; excludes self and bidirectional blocks, limits output and enforces a persistent per-user search quota.';

-- Keep the existing contact-directory and QR lookup behavior (shared
-- conversation required), but return usernames as part of the minimal profile.
DROP FUNCTION IF EXISTS public.get_contact_directory();
DROP FUNCTION IF EXISTS public.get_contact_directory(uuid);

CREATE FUNCTION public.get_contact_directory(p_user_id uuid)
RETURNS TABLE (
  id uuid,
  name text,
  username text,
  avatar_color text,
  avatar_url text,
  status text,
  online boolean
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $function$
  SELECT
    p.id,
    p.name,
    p.username,
    p.avatar_color,
    CASE
      WHEN COALESCE(d.photo_visibility, 'everyone') = 'nobody' THEN NULL
      ELSE p.avatar_url
    END,
    p.status,
    CASE
      WHEN COALESCE(d.show_online_status, true) THEN p.online
      ELSE false
    END
  FROM public.profiles AS p
  LEFT JOIN public.profile_details AS d ON d.user_id = p.id
  WHERE auth.uid() IS NOT NULL
    AND p.id <> auth.uid()
    AND (p_user_id IS NULL OR p.id = p_user_id)
    AND COALESCE(d.profile_visibility, 'everyone') <> 'nobody'
    AND EXISTS (
      SELECT 1
      FROM public.conversation_participants AS viewer_membership
      JOIN public.conversation_participants AS target_membership
        ON target_membership.conversation_id = viewer_membership.conversation_id
      WHERE viewer_membership.user_id = auth.uid()
        AND target_membership.user_id = p.id
    )
    AND NOT EXISTS (
      SELECT 1
      FROM public.blocked_users AS b
      WHERE (b.blocker_id = auth.uid() AND b.blocked_id = p.id)
         OR (b.blocker_id = p.id AND b.blocked_id = auth.uid())
    )
  ORDER BY p.name ASC, p.id ASC;
$function$;

CREATE FUNCTION public.get_contact_directory()
RETURNS TABLE (
  id uuid,
  name text,
  username text,
  avatar_color text,
  avatar_url text,
  status text,
  online boolean
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $function$
  SELECT *
  FROM public.get_contact_directory(NULL::uuid);
$function$;

REVOKE ALL ON FUNCTION public.get_contact_directory() FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.get_contact_directory(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_contact_directory() TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.get_contact_directory(uuid) TO authenticated, service_role;

COMMENT ON FUNCTION public.get_contact_directory(uuid) IS
  'Returns minimal profile fields only for shared-conversation contacts; excludes self and either-direction blocks.';

NOTIFY pgrst, 'reload schema';
COMMIT;
