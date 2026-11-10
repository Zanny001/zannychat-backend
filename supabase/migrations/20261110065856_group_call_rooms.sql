-- Group-call room and participant state for the LiveKit SFU path.
-- Media transport is intentionally not implemented as a peer mesh: the SFU
-- keeps upload fan-out bounded as group size grows. Backend-only tables.
BEGIN;

CREATE TABLE IF NOT EXISTS public.group_call_rooms (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  conversation_id uuid NOT NULL REFERENCES public.conversations(id) ON DELETE CASCADE,
  host_user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  room_name text NOT NULL UNIQUE,
  status text NOT NULL DEFAULT 'ringing'
    CHECK (status IN ('ringing','active','ended','expired')),
  max_participants integer NOT NULL DEFAULT 8
    CHECK (max_participants BETWEEN 2 AND 16),
  created_at timestamptz NOT NULL DEFAULT now(),
  started_at timestamptz,
  ended_at timestamptz,
  expires_at timestamptz NOT NULL DEFAULT (now() + interval '2 minutes'),
  CHECK ((status <> 'ended') OR ended_at IS NOT NULL)
);

CREATE UNIQUE INDEX IF NOT EXISTS group_call_one_active_room_per_conversation
  ON public.group_call_rooms(conversation_id)
  WHERE status IN ('ringing','active');
CREATE INDEX IF NOT EXISTS group_call_rooms_recent_idx
  ON public.group_call_rooms(conversation_id, created_at DESC);

CREATE TABLE IF NOT EXISTS public.group_call_participants (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  room_id uuid NOT NULL REFERENCES public.group_call_rooms(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  role text NOT NULL DEFAULT 'member' CHECK (role IN ('host','member')),
  status text NOT NULL DEFAULT 'invited'
    CHECK (status IN ('invited','joined','left','declined')),
  invited_at timestamptz NOT NULL DEFAULT now(),
  joined_at timestamptz,
  left_at timestamptz,
  UNIQUE(room_id, user_id),
  CHECK ((status <> 'joined') OR joined_at IS NOT NULL)
);

CREATE INDEX IF NOT EXISTS group_call_participants_user_recent_idx
  ON public.group_call_participants(user_id, invited_at DESC);
CREATE INDEX IF NOT EXISTS group_call_participants_room_status_idx
  ON public.group_call_participants(room_id, status);

ALTER TABLE public.group_call_rooms ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.group_call_participants ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.group_call_rooms, public.group_call_participants FROM PUBLIC, anon, authenticated;
GRANT ALL ON public.group_call_rooms, public.group_call_participants TO service_role;

COMMENT ON TABLE public.group_call_rooms IS
  'SFU-backed group audio/video call rooms. All access is mediated by authenticated backend routes.';
COMMENT ON TABLE public.group_call_participants IS
  'Group-call invitations and participant lifecycle. Media tokens are issued only by the backend.';

COMMIT;