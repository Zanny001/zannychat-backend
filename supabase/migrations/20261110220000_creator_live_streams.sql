-- Creator LIVE rooms, audience presence, moderated chat, reactions and reports.
-- Media is SFU-backed; viewer tokens are subscribe-only.
BEGIN;

CREATE TABLE IF NOT EXISTS public.live_streams (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  creator_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  title text NOT NULL CHECK (char_length(btrim(title)) BETWEEN 1 AND 80),
  description text NOT NULL DEFAULT '' CHECK (char_length(description) <= 500),
  room_name text NOT NULL UNIQUE,
  visibility text NOT NULL DEFAULT 'public'
    CHECK (visibility IN ('public','followers','private')),
  status text NOT NULL DEFAULT 'live' CHECK (status IN ('live','ended')),
  allow_comments boolean NOT NULL DEFAULT true,
  allow_guests boolean NOT NULL DEFAULT false,
  viewer_limit integer NOT NULL DEFAULT 500 CHECK (viewer_limit BETWEEN 1 AND 10000),
  created_at timestamptz NOT NULL DEFAULT now(),
  started_at timestamptz NOT NULL DEFAULT now(),
  ended_at timestamptz
);

CREATE INDEX IF NOT EXISTS live_streams_discover_idx
  ON public.live_streams(status, visibility, started_at DESC);
CREATE INDEX IF NOT EXISTS live_streams_creator_recent_idx
  ON public.live_streams(creator_id, created_at DESC);

CREATE TABLE IF NOT EXISTS public.live_stream_participants (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  stream_id uuid NOT NULL REFERENCES public.live_streams(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  role text NOT NULL CHECK (role IN ('creator','viewer','guest')),
  status text NOT NULL DEFAULT 'joined' CHECK (status IN ('joined','left','blocked')),
  joined_at timestamptz NOT NULL DEFAULT now(),
  left_at timestamptz,
  UNIQUE(stream_id, user_id)
);
CREATE INDEX IF NOT EXISTS live_stream_participants_stream_status_idx
  ON public.live_stream_participants(stream_id, status);
CREATE INDEX IF NOT EXISTS live_stream_participants_user_recent_idx
  ON public.live_stream_participants(user_id, joined_at DESC);

CREATE TABLE IF NOT EXISTS public.live_stream_comments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  stream_id uuid NOT NULL REFERENCES public.live_streams(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  body text NOT NULL CHECK (char_length(btrim(body)) BETWEEN 1 AND 500),
  moderation_status text NOT NULL DEFAULT 'visible'
    CHECK (moderation_status IN ('visible','hidden','pending')),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS live_stream_comments_recent_idx
  ON public.live_stream_comments(stream_id, created_at DESC);

CREATE TABLE IF NOT EXISTS public.live_stream_reactions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  stream_id uuid NOT NULL REFERENCES public.live_streams(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  reaction text NOT NULL CHECK (reaction IN ('heart','clap','laugh','wow','fire')),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS live_stream_reactions_recent_idx
  ON public.live_stream_reactions(stream_id, created_at DESC);

CREATE TABLE IF NOT EXISTS public.live_stream_reports (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  stream_id uuid NOT NULL REFERENCES public.live_streams(id) ON DELETE CASCADE,
  reporter_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  reason text NOT NULL CHECK (reason IN ('harassment','hate','nudity','violence','spam','copyright','other')),
  details text NOT NULL DEFAULT '' CHECK (char_length(details) <= 1000),
  status text NOT NULL DEFAULT 'open' CHECK (status IN ('open','reviewing','resolved','dismissed')),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(stream_id, reporter_id)
);

ALTER TABLE public.live_streams ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.live_stream_participants ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.live_stream_comments ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.live_stream_reactions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.live_stream_reports ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON public.live_streams, public.live_stream_participants,
  public.live_stream_comments, public.live_stream_reactions, public.live_stream_reports
  FROM PUBLIC, anon, authenticated;
GRANT ALL ON public.live_streams, public.live_stream_participants,
  public.live_stream_comments, public.live_stream_reactions, public.live_stream_reports
  TO service_role;

COMMENT ON TABLE public.live_streams IS
  'Creator LIVE broadcast metadata. Media transport and audience fan-out are provided by a configured SFU.';
COMMENT ON TABLE public.live_stream_reports IS
  'Audience safety reports for creator LIVE streams; review must be handled by authorized moderators.';

COMMIT;