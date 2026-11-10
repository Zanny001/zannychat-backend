-- Cover foreign-key lookup paths added by Creator LIVE moderation and invitations.
BEGIN;
CREATE INDEX IF NOT EXISTS live_stream_comments_user_idx ON public.live_stream_comments(user_id);
CREATE INDEX IF NOT EXISTS live_stream_reactions_user_idx ON public.live_stream_reactions(user_id);
CREATE INDEX IF NOT EXISTS live_stream_reports_reporter_idx ON public.live_stream_reports(reporter_id);
CREATE INDEX IF NOT EXISTS live_stream_reports_reviewed_by_idx ON public.live_stream_reports(reviewed_by);
CREATE INDEX IF NOT EXISTS live_stream_invites_invited_by_idx ON public.live_stream_invites(invited_by);
CREATE INDEX IF NOT EXISTS live_stream_invites_requested_by_idx ON public.live_stream_invites(requested_by);
CREATE INDEX IF NOT EXISTS live_stream_moderators_appointed_by_idx ON public.live_stream_moderators(appointed_by);
COMMIT;
