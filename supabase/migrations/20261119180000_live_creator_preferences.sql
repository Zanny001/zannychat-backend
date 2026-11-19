-- Durable, account-scoped LIVE creator defaults.
-- Clients cannot read or write this table directly; authenticated API routes
-- validate values and bind every operation to req.user.id.
BEGIN;

CREATE TABLE IF NOT EXISTS public.live_creator_preferences (
  user_id uuid PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  experience_mode text NOT NULL DEFAULT 'broadcast'
    CHECK (experience_mode IN ('broadcast', 'video_chat', 'audio_room')),
  visibility text NOT NULL DEFAULT 'public'
    CHECK (visibility IN ('public', 'followers', 'private')),
  category text NOT NULL DEFAULT 'social'
    CHECK (category IN (
      'entertainment', 'social', 'politics', 'science', 'education',
      'finance', 'technology', 'sports', 'business', 'health', 'other'
    )),
  allow_guests boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.live_creator_preferences ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.live_creator_preferences FROM PUBLIC, anon, authenticated;
GRANT ALL ON public.live_creator_preferences TO service_role;

CREATE INDEX IF NOT EXISTS live_creator_preferences_updated_idx
  ON public.live_creator_preferences(updated_at DESC);

COMMENT ON TABLE public.live_creator_preferences IS
  'Account-scoped defaults for the next creator LIVE setup. Does not mutate active streams.';

COMMIT;
