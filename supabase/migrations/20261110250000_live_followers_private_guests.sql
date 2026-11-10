-- Follower-gated/private Creator LIVE access and approved guest participation.
BEGIN;

CREATE TABLE IF NOT EXISTS public.live_creator_follows (
  follower_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  creator_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (follower_id, creator_id),
  CHECK (follower_id <> creator_id)
);
CREATE INDEX IF NOT EXISTS live_creator_follows_creator_idx
  ON public.live_creator_follows(creator_id, created_at DESC);

CREATE TABLE IF NOT EXISTS public.live_stream_invites (
  stream_id uuid NOT NULL REFERENCES public.live_streams(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  invited_by uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  requested_by uuid REFERENCES auth.users(id) ON DELETE CASCADE,
  invitation_type text NOT NULL CHECK (invitation_type IN ('viewer','guest')),
  status text NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending','requested','accepted','declined','revoked')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (stream_id, user_id, invitation_type),
  CHECK (user_id <> invited_by)
);
CREATE INDEX IF NOT EXISTS live_stream_invites_user_status_idx
  ON public.live_stream_invites(user_id, status, created_at DESC);

ALTER TABLE public.live_creator_follows ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.live_stream_invites ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.live_creator_follows, public.live_stream_invites
  FROM PUBLIC, anon, authenticated;
GRANT ALL ON public.live_creator_follows, public.live_stream_invites TO service_role;

-- Admission is serialized on the stream row. Followers and private invitations
-- are rechecked in the transaction, not trusted from the route's preflight.
CREATE OR REPLACE FUNCTION public.join_live_stream(p_stream_id uuid, p_user_id uuid)
RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_stream public.live_streams%rowtype;
  v_joined integer;
  v_role text;
  v_existing_status text;
  v_invite public.live_stream_invites%rowtype;
  v_has_invite boolean := false;
  v_is_follower boolean := false;
BEGIN
  SELECT * INTO v_stream
    FROM public.live_streams
   WHERE id = p_stream_id
   FOR UPDATE;
  IF NOT FOUND OR v_stream.status <> 'live' THEN
    RAISE EXCEPTION 'LIVE stream has ended' USING ERRCODE = 'P0001';
  END IF;

  IF p_user_id <> v_stream.creator_id AND EXISTS (
    SELECT 1 FROM public.blocked_users b
     WHERE (b.blocker_id = v_stream.creator_id AND b.blocked_id = p_user_id)
        OR (b.blocker_id = p_user_id AND b.blocked_id = v_stream.creator_id)
  ) THEN
    RAISE EXCEPTION 'LIVE stream is unavailable' USING ERRCODE = '42501';
  END IF;

  IF p_user_id <> v_stream.creator_id THEN
    SELECT * INTO v_invite
      FROM public.live_stream_invites
     WHERE stream_id = p_stream_id AND user_id = p_user_id
       AND status IN ('pending','accepted')
     ORDER BY CASE WHEN invitation_type = 'guest' AND status = 'accepted' THEN 0 ELSE 1 END,
              created_at DESC
     LIMIT 1
     FOR UPDATE;
    v_has_invite := FOUND;

    SELECT EXISTS (
      SELECT 1 FROM public.live_creator_follows
       WHERE follower_id = p_user_id AND creator_id = v_stream.creator_id
    ) INTO v_is_follower;

    IF v_stream.visibility = 'followers' AND NOT v_is_follower
       AND NOT (v_has_invite AND v_invite.invitation_type IN ('viewer','guest')) THEN
      RAISE EXCEPTION 'LIVE stream is for followers only' USING ERRCODE = '42501';
    END IF;

    IF v_stream.visibility = 'private'
       AND NOT (v_has_invite AND v_invite.invitation_type IN ('viewer','guest')) THEN
      RAISE EXCEPTION 'LIVE stream invitation required' USING ERRCODE = '42501';
    END IF;
  END IF;

  v_role := CASE
    WHEN p_user_id = v_stream.creator_id THEN 'creator'
    WHEN v_stream.allow_guests AND v_has_invite
      AND v_invite.invitation_type = 'guest' AND v_invite.status = 'accepted' THEN 'guest'
    ELSE 'viewer'
  END;

  SELECT status INTO v_existing_status
    FROM public.live_stream_participants
   WHERE stream_id = p_stream_id AND user_id = p_user_id;
  IF NOT FOUND OR v_existing_status <> 'joined' THEN
    SELECT count(*) INTO v_joined
      FROM public.live_stream_participants
     WHERE stream_id = p_stream_id AND status = 'joined';
    IF v_joined >= v_stream.viewer_limit THEN
      RAISE EXCEPTION 'LIVE audience is full' USING ERRCODE = 'P0001';
    END IF;
  END IF;

  INSERT INTO public.live_stream_participants(stream_id, user_id, role, status, joined_at, left_at)
  VALUES (p_stream_id, p_user_id, v_role, 'joined', now(), NULL)
  ON CONFLICT (stream_id, user_id) DO UPDATE
    SET role = EXCLUDED.role, status = 'joined', joined_at = now(), left_at = NULL;

  IF v_has_invite AND v_invite.invitation_type = 'viewer' AND v_invite.status = 'pending' THEN
    UPDATE public.live_stream_invites
       SET status = 'accepted', updated_at = now()
     WHERE stream_id = p_stream_id AND user_id = p_user_id;
  END IF;
  RETURN v_role;
END;
$$;

-- Private stream creation and its initial invitations are one transaction.
CREATE OR REPLACE FUNCTION public.create_live_stream(
  p_stream_id uuid,
  p_creator_id uuid,
  p_title text,
  p_description text,
  p_room_name text,
  p_visibility text,
  p_allow_guests boolean,
  p_invited_user_ids uuid[]
)
RETURNS public.live_streams
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_stream public.live_streams%rowtype;
  v_invite_ids uuid[] := COALESCE(p_invited_user_ids, ARRAY[]::uuid[]);
  v_now timestamptz := now();
BEGIN
  IF p_title IS NULL OR char_length(btrim(p_title)) NOT BETWEEN 1 AND 80
     OR p_description IS NULL OR char_length(p_description) > 500
     OR p_room_name IS NULL OR char_length(p_room_name) NOT BETWEEN 1 AND 128
     OR p_visibility IS NULL OR p_visibility NOT IN ('public','followers','private')
     OR p_allow_guests IS NULL OR cardinality(v_invite_ids) > 100
     OR (p_visibility = 'private' AND cardinality(v_invite_ids) = 0)
     OR (p_visibility <> 'private' AND cardinality(v_invite_ids) > 0)
     OR EXISTS (SELECT 1 FROM unnest(v_invite_ids) AS invitee(user_id)
                 WHERE invitee.user_id IS NULL OR invitee.user_id = p_creator_id)
     OR cardinality(v_invite_ids) <> (SELECT count(DISTINCT user_id) FROM unnest(v_invite_ids) AS invitee(user_id)) THEN
    RAISE EXCEPTION 'invalid LIVE stream details or private invitees' USING ERRCODE = '22023';
  END IF;

  IF EXISTS (
    SELECT 1
      FROM unnest(v_invite_ids) AS invitee(user_id)
      JOIN public.blocked_users b
        ON (b.blocker_id = p_creator_id AND b.blocked_id = invitee.user_id)
        OR (b.blocker_id = invitee.user_id AND b.blocked_id = p_creator_id)
  ) THEN
    RAISE EXCEPTION 'blocked account cannot be invited' USING ERRCODE = '42501';
  END IF;

  INSERT INTO public.live_streams(
    id, creator_id, title, description, visibility, room_name, status,
    allow_guests, started_at
  ) VALUES (
    p_stream_id, p_creator_id, btrim(p_title), btrim(p_description),
    p_visibility, p_room_name, 'live', p_allow_guests, v_now
  ) RETURNING * INTO v_stream;

  INSERT INTO public.live_stream_participants(stream_id, user_id, role, status, joined_at)
  VALUES (p_stream_id, p_creator_id, 'creator', 'joined', v_now);

  IF p_visibility = 'private' THEN
    INSERT INTO public.live_stream_invites(
      stream_id, user_id, invited_by, invitation_type, status, created_at, updated_at
    )
    SELECT p_stream_id, invitee.user_id, p_creator_id, 'viewer', 'pending', v_now, v_now
      FROM unnest(v_invite_ids) AS invitee(user_id);
  END IF;

  RETURN v_stream;
END;
$$;

REVOKE ALL ON FUNCTION public.join_live_stream(uuid, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.join_live_stream(uuid, uuid) TO service_role;

COMMENT ON TABLE public.live_creator_follows IS
  'One-way creator follows used to authorize follower-only LIVE broadcasts.';
COMMENT ON TABLE public.live_stream_invites IS
  'Per-stream viewer invitations and guest participation requests/approvals; backend-only.';
REVOKE ALL ON FUNCTION public.create_live_stream(uuid, uuid, text, text, text, text, boolean, uuid[])
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.create_live_stream(uuid, uuid, text, text, text, text, boolean, uuid[])
  TO service_role;

COMMIT;
