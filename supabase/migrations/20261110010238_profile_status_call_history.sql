-- ZannyChat 1.2.240: restore private profile media, server-timed status creation,
-- and durable participant-visible audio/video call history.
-- Additive only. Existing profile/status/call rows and media objects are preserved.

BEGIN;

-- Profile editing currently depends on profile_details and private-avatars.
-- The production project is missing both prerequisites.
ALTER TABLE public.profiles ADD COLUMN IF NOT EXISTS username text;
CREATE UNIQUE INDEX IF NOT EXISTS profiles_username_lower_unique
  ON public.profiles (lower(username))
  WHERE username IS NOT NULL AND btrim(username) <> '';
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'profiles_username_format_check'
      AND conrelid = 'public.profiles'::regclass
  ) THEN
    ALTER TABLE public.profiles ADD CONSTRAINT profiles_username_format_check
      CHECK (username IS NULL OR username ~ '^[A-Za-z0-9_]{3,24}$');
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS public.profile_details (
  user_id uuid PRIMARY KEY REFERENCES public.profiles(id) ON DELETE CASCADE,
  about text NOT NULL DEFAULT '',
  occupation text NOT NULL DEFAULT '',
  location text NOT NULL DEFAULT '',
  website text NOT NULL DEFAULT '',
  birthday date,
  pronouns text NOT NULL DEFAULT '',
  cover_image_url text,
  avatar_path text,
  cover_path text,
  profile_visibility text NOT NULL DEFAULT 'everyone'
    CHECK (profile_visibility IN ('everyone','contacts','nobody')),
  show_location boolean NOT NULL DEFAULT false,
  show_occupation boolean NOT NULL DEFAULT false,
  show_website boolean NOT NULL DEFAULT true,
  show_birthday boolean NOT NULL DEFAULT false,
  show_pronouns boolean NOT NULL DEFAULT true,
  show_last_seen boolean NOT NULL DEFAULT false,
  show_online_status boolean NOT NULL DEFAULT true,
  show_read_receipts boolean NOT NULL DEFAULT true,
  photo_visibility text NOT NULL DEFAULT 'everyone'
    CHECK (photo_visibility IN ('everyone','contacts','nobody')),
  group_invite_permission text NOT NULL DEFAULT 'everyone'
    CHECK (group_invite_permission IN ('everyone','contacts','nobody')),
  call_permission text NOT NULL DEFAULT 'everyone'
    CHECK (call_permission IN ('everyone','contacts','nobody')),
  status_audience text NOT NULL DEFAULT 'contacts'
    CHECK (status_audience IN ('everyone','contacts','selected','nobody')),
  last_seen_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE public.profile_details ADD COLUMN IF NOT EXISTS avatar_path text;
ALTER TABLE public.profile_details ADD COLUMN IF NOT EXISTS cover_path text;
ALTER TABLE public.profile_details ADD COLUMN IF NOT EXISTS last_seen_at timestamptz;
ALTER TABLE public.profile_details ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.profile_details FROM anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.profile_details TO authenticated;
DROP POLICY IF EXISTS "Owners manage their private profile details" ON public.profile_details;
CREATE POLICY "Owners manage their private profile details"
  ON public.profile_details FOR ALL TO authenticated
  USING (user_id = (SELECT auth.uid()))
  WITH CHECK (user_id = (SELECT auth.uid()));

CREATE OR REPLACE FUNCTION public.can_view_profile_avatar(p_user_id uuid)
RETURNS boolean
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_viewer uuid := auth.uid();
  v_visibility text;
BEGIN
  IF v_viewer IS NULL OR p_user_id IS NULL THEN RETURN false; END IF;
  IF v_viewer = p_user_id THEN RETURN true; END IF;
  IF EXISTS (
    SELECT 1 FROM public.blocked_users b
    WHERE (b.blocker_id = v_viewer AND b.blocked_id = p_user_id)
       OR (b.blocker_id = p_user_id AND b.blocked_id = v_viewer)
  ) THEN RETURN false; END IF;
  SELECT COALESCE(d.photo_visibility, 'everyone') INTO v_visibility
  FROM public.profile_details d WHERE d.user_id = p_user_id;
  v_visibility := COALESCE(v_visibility, 'everyone');
  IF v_visibility = 'nobody' THEN RETURN false; END IF;
  IF v_visibility = 'everyone' THEN RETURN true; END IF;
  RETURN EXISTS (
    SELECT 1
    FROM public.conversation_participants mine
    JOIN public.conversation_participants theirs
      ON theirs.conversation_id = mine.conversation_id
    WHERE mine.user_id = v_viewer AND theirs.user_id = p_user_id
  );
END;
$$;

CREATE OR REPLACE FUNCTION public.get_visible_profile_avatar_path(p_user_id uuid)
RETURNS text
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT d.avatar_path
  FROM public.profile_details d
  WHERE d.user_id = p_user_id
    AND public.can_view_profile_avatar(p_user_id)
    AND d.avatar_path IS NOT NULL
    AND d.avatar_path LIKE p_user_id::text || '/%'
    AND position('..' in d.avatar_path) = 0;
$$;

CREATE OR REPLACE FUNCTION public.get_public_profile_details(p_user_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_details public.profile_details%rowtype;
  v_viewer uuid := auth.uid();
  v_is_contact boolean := false;
BEGIN
  IF v_viewer IS NULL THEN
    RAISE EXCEPTION 'Authentication required' USING ERRCODE = '42501';
  END IF;
  IF EXISTS (
    SELECT 1 FROM public.blocked_users b
    WHERE (b.blocker_id = v_viewer AND b.blocked_id = p_user_id)
       OR (b.blocker_id = p_user_id AND b.blocked_id = v_viewer)
  ) THEN RETURN '{}'::jsonb; END IF;
  SELECT * INTO v_details FROM public.profile_details WHERE user_id = p_user_id;
  IF NOT FOUND THEN RETURN '{}'::jsonb; END IF;
  IF v_viewer = p_user_id THEN
    RETURN to_jsonb(v_details) - 'user_id' - 'avatar_path' - 'cover_path';
  END IF;
  SELECT EXISTS (
    SELECT 1 FROM public.conversation_participants a
    JOIN public.conversation_participants b ON b.conversation_id = a.conversation_id
    WHERE a.user_id = v_viewer AND b.user_id = p_user_id
  ) INTO v_is_contact;
  IF v_details.profile_visibility = 'nobody'
     OR (v_details.profile_visibility = 'contacts' AND NOT v_is_contact) THEN
    RETURN '{}'::jsonb;
  END IF;
  RETURN jsonb_strip_nulls(jsonb_build_object(
    'about', nullif(v_details.about, ''),
    'occupation', CASE WHEN v_details.show_occupation THEN nullif(v_details.occupation, '') END,
    'location', CASE WHEN v_details.show_location THEN nullif(v_details.location, '') END,
    'website', CASE WHEN v_details.show_website THEN nullif(v_details.website, '') END,
    'birthday', CASE WHEN v_details.show_birthday THEN v_details.birthday END,
    'pronouns', CASE WHEN v_details.show_pronouns THEN nullif(v_details.pronouns, '') END,
    'cover_image_url', CASE WHEN public.can_view_profile_avatar(p_user_id) THEN v_details.cover_image_url END,
    'show_last_seen', v_details.show_last_seen,
    'show_online_status', v_details.show_online_status,
    'show_read_receipts', v_details.show_read_receipts
  ));
END;
$$;

CREATE OR REPLACE FUNCTION public.get_visible_profile_cover_path(p_user_id uuid)
RETURNS text
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT d.cover_path
  FROM public.profile_details d
  WHERE d.user_id = p_user_id
    AND public.can_view_profile_avatar(p_user_id)
    AND public.get_public_profile_details(p_user_id) <> '{}'::jsonb
    AND d.cover_path IS NOT NULL
    AND d.cover_path LIKE p_user_id::text || '/%'
    AND position('..' in d.cover_path) = 0;
$$;



REVOKE ALL ON FUNCTION public.can_view_profile_avatar(uuid) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.get_visible_profile_avatar_path(uuid) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.get_visible_profile_cover_path(uuid) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.get_public_profile_details(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.can_view_profile_avatar(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.get_visible_profile_avatar_path(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.get_visible_profile_cover_path(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.get_public_profile_details(uuid) TO authenticated;

INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES (
  'private-avatars', 'private-avatars', false, 15728640,
  ARRAY['image/jpeg','image/png','image/webp','image/gif','image/heic','image/heif']
)
ON CONFLICT (id) DO UPDATE SET
  public = false,
  file_size_limit = EXCLUDED.file_size_limit,
  allowed_mime_types = EXCLUDED.allowed_mime_types;

DROP POLICY IF EXISTS "Private profile media owner upload" ON storage.objects;
CREATE POLICY "Private profile media owner upload"
  ON storage.objects FOR INSERT TO authenticated
  WITH CHECK (
    bucket_id = 'private-avatars'
    AND (storage.foldername(name))[1] = (SELECT auth.uid())::text
  );
DROP POLICY IF EXISTS "Private profile media owner update" ON storage.objects;
CREATE POLICY "Private profile media owner update"
  ON storage.objects FOR UPDATE TO authenticated
  USING (
    bucket_id = 'private-avatars'
    AND (storage.foldername(name))[1] = (SELECT auth.uid())::text
  )
  WITH CHECK (
    bucket_id = 'private-avatars'
    AND (storage.foldername(name))[1] = (SELECT auth.uid())::text
  );
DROP POLICY IF EXISTS "Private profile media owner delete" ON storage.objects;
CREATE POLICY "Private profile media owner delete"
  ON storage.objects FOR DELETE TO authenticated
  USING (
    bucket_id = 'private-avatars'
    AND (storage.foldername(name))[1] = (SELECT auth.uid())::text
  );
DROP POLICY IF EXISTS "Private profile media visible by photo privacy" ON storage.objects;
CREATE POLICY "Private profile media visible by photo privacy"
  ON storage.objects FOR SELECT TO authenticated
  USING (
    bucket_id = 'private-avatars'
    AND public.can_view_profile_avatar(((storage.foldername(name))[1])::uuid)
  );

-- Enforce the existing call_permission setting at the database boundary.
CREATE OR REPLACE FUNCTION public.enforce_call_recipient_privacy()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_permission text;
  v_is_contact boolean;
BEGIN
  SELECT COALESCE(pd.call_permission, 'everyone') INTO v_permission
  FROM public.profile_details pd WHERE pd.user_id = NEW.callee_id;
  v_permission := COALESCE(v_permission, 'everyone');
  SELECT EXISTS (
    SELECT 1
    FROM public.conversation_participants a
    JOIN public.conversation_participants b ON b.conversation_id = a.conversation_id
    WHERE a.user_id = NEW.caller_id AND b.user_id = NEW.callee_id
  ) INTO v_is_contact;
  IF v_permission = 'nobody' OR (v_permission = 'contacts' AND NOT v_is_contact) THEN
    RAISE EXCEPTION 'calls are unavailable for this contact' USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION public.enforce_call_recipient_privacy() FROM PUBLIC, anon, authenticated;
DROP TRIGGER IF EXISTS enforce_call_recipient_privacy ON public.call_sessions;
CREATE TRIGGER enforce_call_recipient_privacy
  BEFORE INSERT ON public.call_sessions
  FOR EACH ROW EXECUTE FUNCTION public.enforce_call_recipient_privacy();

-- Create status rows with PostgreSQL time. The old client sent created_at and
-- expires_at from device clocks; RLS rejected rows whose expiry was already past
-- according to the database clock.
CREATE OR REPLACE FUNCTION public.create_status_update(
  p_text text,
  p_audience text,
  p_media_kind text,
  p_expiry_hours integer
)
RETURNS public.status_updates
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = ''
AS $$
DECLARE
  v_user uuid := auth.uid();
  v_created timestamptz := pg_catalog.now();
  v_row public.status_updates%rowtype;
  v_hours integer := COALESCE(p_expiry_hours, 24);
  v_text text := nullif(pg_catalog.btrim(COALESCE(p_text, '')), '');
BEGIN
  IF v_user IS NULL THEN
    RAISE EXCEPTION 'Authentication required' USING ERRCODE = '42501';
  END IF;
  IF v_hours NOT IN (6, 12, 24, 48) THEN
    RAISE EXCEPTION 'Invalid status expiry. Choose 6, 12, 24 or 48 hours.' USING ERRCODE = '22023';
  END IF;
  IF COALESCE(p_audience, '') NOT IN ('contacts', 'selected_contacts', 'only_me') THEN
    RAISE EXCEPTION 'Invalid status audience.' USING ERRCODE = '22023';
  END IF;
  IF p_media_kind IS NOT NULL AND p_media_kind NOT IN ('image', 'video') THEN
    RAISE EXCEPTION 'Invalid status media type.' USING ERRCODE = '22023';
  END IF;
  IF p_media_kind IS NULL AND v_text IS NULL THEN
    RAISE EXCEPTION 'Write a status before publishing.' USING ERRCODE = '22023';
  END IF;
  IF pg_catalog.char_length(COALESCE(v_text, '')) > 700 THEN
    RAISE EXCEPTION 'Status text is too long.' USING ERRCODE = '22023';
  END IF;

  INSERT INTO public.status_updates (
    user_id, text, audience, media_kind, media_path, created_at, expires_at
  ) VALUES (
    v_user, v_text, p_audience, p_media_kind,
    CASE WHEN p_media_kind IS NULL THEN NULL ELSE 'pending' END,
    v_created, v_created + pg_catalog.make_interval(hours => v_hours)
  )
  RETURNING * INTO v_row;
  RETURN v_row;
END;
$$;
REVOKE ALL ON FUNCTION public.create_status_update(text, text, text, integer) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.create_status_update(text, text, text, integer) TO authenticated;

-- Keep call_sessions as the durable history source for both participants.
-- A participant may mark an invitation missed only after its expiry.
CREATE OR REPLACE FUNCTION public.validate_call_session_write()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  actor uuid := auth.uid();
  member_count integer;
  total_count integer;
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF actor IS NULL OR NEW.caller_id <> actor OR NEW.status <> 'ringing' THEN
      RAISE EXCEPTION 'invalid call creator or initial state' USING ERRCODE = '42501';
    END IF;
    PERFORM pg_advisory_xact_lock(hashtextextended(LEAST(NEW.caller_id::text, NEW.callee_id::text), 0));
    PERFORM pg_advisory_xact_lock(hashtextextended(GREATEST(NEW.caller_id::text, NEW.callee_id::text), 0));
    IF EXISTS (
      SELECT 1 FROM public.call_sessions c
      WHERE ((c.status = 'accepted' AND c.last_activity_at > now() - interval '3 minutes')
        OR (c.status = 'ringing' AND c.expires_at > now()))
        AND (c.caller_id IN (NEW.caller_id, NEW.callee_id) OR c.callee_id IN (NEW.caller_id, NEW.callee_id))
    ) THEN
      RAISE EXCEPTION 'a participant is already in an active call' USING ERRCODE = '23505';
    END IF;
    SELECT count(*) INTO member_count FROM public.conversation_participants cp
      WHERE cp.conversation_id = NEW.conversation_id AND cp.user_id IN (NEW.caller_id, NEW.callee_id);
    SELECT count(*) INTO total_count FROM public.conversation_participants cp WHERE cp.conversation_id = NEW.conversation_id;
    IF member_count <> 2 OR total_count <> 2 THEN
      RAISE EXCEPTION 'calls are supported only between the two members of a direct conversation' USING ERRCODE = '42501';
    END IF;
    IF EXISTS (SELECT 1 FROM public.blocked_users b
      WHERE (b.blocker_id = NEW.caller_id AND b.blocked_id = NEW.callee_id)
         OR (b.blocker_id = NEW.callee_id AND b.blocked_id = NEW.caller_id)) THEN
      RAISE EXCEPTION 'calls are unavailable for this contact' USING ERRCODE = '42501';
    END IF;
    NEW.last_activity_at := now();
    RETURN NEW;
  END IF;

  IF NEW.id <> OLD.id OR NEW.conversation_id <> OLD.conversation_id
     OR NEW.caller_id <> OLD.caller_id OR NEW.callee_id <> OLD.callee_id
     OR NEW.call_type <> OLD.call_type OR NEW.created_at <> OLD.created_at
     OR NEW.expires_at <> OLD.expires_at THEN
    RAISE EXCEPTION 'call identity fields are immutable' USING ERRCODE = '42501';
  END IF;
  IF actor IS NULL THEN
    IF current_user <> 'postgres' THEN
      RAISE EXCEPTION 'not a call participant' USING ERRCODE = '42501';
    END IF;
  ELSIF actor NOT IN (OLD.caller_id, OLD.callee_id) THEN
    RAISE EXCEPTION 'not a call participant' USING ERRCODE = '42501';
  END IF;

  IF NEW.status = OLD.status THEN
    IF NEW.accepted_at IS DISTINCT FROM OLD.accepted_at OR NEW.ended_at IS DISTINCT FROM OLD.ended_at THEN
      RAISE EXCEPTION 'call lifecycle timestamps are immutable outside a state transition' USING ERRCODE = '42501';
    END IF;
    IF NEW.last_activity_at IS DISTINCT FROM OLD.last_activity_at
       AND (OLD.status <> 'accepted' OR NEW.last_activity_at < OLD.last_activity_at
         OR NEW.last_activity_at > now() + interval '10 seconds') THEN
      RAISE EXCEPTION 'invalid call heartbeat lease' USING ERRCODE = '42501';
    END IF;
    RETURN NEW;
  END IF;

  IF OLD.status = 'ringing' AND NEW.status = 'missed'
     AND (actor IN (OLD.caller_id, OLD.callee_id) OR (actor IS NULL AND current_user = 'postgres')) THEN
    IF now() < OLD.expires_at THEN
      RAISE EXCEPTION 'call invitation has not expired' USING ERRCODE = '42501';
    END IF;
    NEW.accepted_at := OLD.accepted_at;
    NEW.ended_at := now();
  ELSIF OLD.status = 'ringing' AND NEW.status IN ('accepted', 'declined') AND actor = OLD.callee_id THEN
    IF now() > OLD.expires_at THEN
      NEW.status := 'missed';
      NEW.accepted_at := OLD.accepted_at;
      NEW.ended_at := now();
    ELSIF NEW.status = 'accepted' THEN
      NEW.accepted_at := now();
      NEW.ended_at := OLD.ended_at;
      NEW.last_activity_at := now();
    ELSE
      NEW.accepted_at := OLD.accepted_at;
      NEW.ended_at := now();
    END IF;
  ELSIF OLD.status = 'ringing' AND NEW.status = 'cancelled' AND actor = OLD.caller_id THEN
    IF now() >= OLD.expires_at THEN NEW.status := 'missed'; END IF;
    NEW.accepted_at := OLD.accepted_at;
    NEW.ended_at := now();
  ELSIF OLD.status = 'accepted' AND NEW.status = 'ended' AND actor IN (OLD.caller_id, OLD.callee_id) THEN
    NEW.accepted_at := OLD.accepted_at;
    NEW.ended_at := now();
  ELSE
    RAISE EXCEPTION 'invalid call state transition' USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END;
$$;

CREATE INDEX IF NOT EXISTS call_sessions_callee_recent_idx
  ON public.call_sessions (callee_id, created_at DESC);

CREATE OR REPLACE FUNCTION public.cleanup_stale_call_signals()
RETURNS bigint
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  deleted_count bigint;
BEGIN
  UPDATE public.call_sessions
    SET status = 'missed', ended_at = now()
    WHERE status = 'ringing' AND expires_at <= now();

  DELETE FROM public.call_signals s
  USING public.call_sessions c
  WHERE s.call_id = c.id
    AND (
      c.status IN ('declined','cancelled','ended','missed','failed')
      OR (c.status = 'ringing' AND c.expires_at < now())
      OR (c.status = 'accepted' AND c.last_activity_at < now() - interval '3 minutes')
      OR s.created_at < now() - interval '1 day'
    );
  GET DIAGNOSTICS deleted_count = ROW_COUNT;
  -- Do not delete call_sessions: both participants use these rows as call history.
  RETURN deleted_count;
END;
$$;
REVOKE ALL ON FUNCTION public.cleanup_stale_call_signals() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.cleanup_stale_call_signals() TO service_role;

COMMENT ON TABLE public.call_sessions IS 'Durable 1:1 audio/video call history for both participants; WebRTC signaling payloads are short-lived.';
COMMENT ON FUNCTION public.create_status_update(text, text, text, integer) IS 'Creates status rows with database time so status RLS expiry checks do not depend on client clock skew.';

NOTIFY pgrst, 'reload schema';
COMMIT;
