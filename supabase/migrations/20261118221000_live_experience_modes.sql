-- Add parallel themed LIVE experience types without changing existing broadcasts.
BEGIN;

ALTER TABLE public.live_streams
  ADD COLUMN IF NOT EXISTS experience_mode text NOT NULL DEFAULT 'broadcast',
  ADD COLUMN IF NOT EXISTS category text NOT NULL DEFAULT 'social';

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'live_streams_experience_mode_check'
      AND conrelid = 'public.live_streams'::regclass
  ) THEN
    ALTER TABLE public.live_streams
      ADD CONSTRAINT live_streams_experience_mode_check
      CHECK (experience_mode IN ('broadcast', 'video_chat', 'audio_room'));
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'live_streams_category_check'
      AND conrelid = 'public.live_streams'::regclass
  ) THEN
    ALTER TABLE public.live_streams
      ADD CONSTRAINT live_streams_category_check
      CHECK (category IN (
        'entertainment', 'social', 'politics', 'science', 'education',
        'finance', 'technology', 'sports', 'business', 'health', 'other'
      ));
  END IF;
END $$;

COMMENT ON COLUMN public.live_streams.experience_mode IS
  'Parallel LIVE experience: existing broadcast, themed multi-participant video chat, or themed audio room.';
COMMENT ON COLUMN public.live_streams.category IS
  'Selected discussion category used to render the LIVE stage visual theme.';

COMMIT;
