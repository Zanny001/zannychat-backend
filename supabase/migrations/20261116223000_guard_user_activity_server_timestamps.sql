-- Keep user-visible activity timestamps authoritative to the database clock.
BEGIN;

CREATE OR REPLACE FUNCTION private.stamp_user_activity_timestamps()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = ''
AS $function$
DECLARE
  v_now timestamptz := pg_catalog.clock_timestamp();
BEGIN
  IF TG_TABLE_NAME = 'status_views' THEN
    NEW.viewed_at := v_now;
  ELSIF TG_TABLE_NAME = 'status_replies' THEN
    NEW.created_at := v_now;
  ELSIF TG_TABLE_NAME = 'message_reactions' THEN
    NEW.created_at := v_now;
  ELSIF TG_TABLE_NAME = 'status_reactions' THEN
    IF TG_OP = 'INSERT' THEN
      NEW.created_at := v_now;
    ELSE
      NEW.created_at := OLD.created_at;
    END IF;
    NEW.updated_at := v_now;
  ELSIF TG_TABLE_NAME = 'pinned_messages' THEN
    NEW.pinned_at := v_now;
  ELSIF TG_TABLE_NAME = 'conversation_participants' THEN
    IF NEW.last_read_at IS DISTINCT FROM OLD.last_read_at THEN
      NEW.last_read_at := v_now;
    END IF;
  ELSIF TG_TABLE_NAME = 'profile_details' THEN
    IF TG_OP = 'INSERT' THEN
      IF NEW.last_seen_at IS NOT NULL THEN
        NEW.last_seen_at := v_now;
      END IF;
    ELSIF NEW.last_seen_at IS DISTINCT FROM OLD.last_seen_at
      AND NEW.last_seen_at IS NOT NULL THEN
      NEW.last_seen_at := v_now;
    END IF;
    NEW.updated_at := v_now;
  END IF;

  RETURN NEW;
END;
$function$;

REVOKE ALL ON FUNCTION private.stamp_user_activity_timestamps()
  FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS status_views_server_timestamp_before_insert ON public.status_views;
CREATE TRIGGER status_views_server_timestamp_before_insert
  BEFORE INSERT ON public.status_views
  FOR EACH ROW EXECUTE FUNCTION private.stamp_user_activity_timestamps();

DROP TRIGGER IF EXISTS status_replies_server_timestamp_before_insert ON public.status_replies;
CREATE TRIGGER status_replies_server_timestamp_before_insert
  BEFORE INSERT ON public.status_replies
  FOR EACH ROW EXECUTE FUNCTION private.stamp_user_activity_timestamps();

DROP TRIGGER IF EXISTS message_reactions_server_timestamp_before_insert ON public.message_reactions;
CREATE TRIGGER message_reactions_server_timestamp_before_insert
  BEFORE INSERT ON public.message_reactions
  FOR EACH ROW EXECUTE FUNCTION private.stamp_user_activity_timestamps();

DROP TRIGGER IF EXISTS status_reactions_server_timestamp_before_write ON public.status_reactions;
CREATE TRIGGER status_reactions_server_timestamp_before_write
  BEFORE INSERT OR UPDATE ON public.status_reactions
  FOR EACH ROW EXECUTE FUNCTION private.stamp_user_activity_timestamps();

DROP TRIGGER IF EXISTS pinned_messages_server_timestamp_before_insert ON public.pinned_messages;
CREATE TRIGGER pinned_messages_server_timestamp_before_insert
  BEFORE INSERT ON public.pinned_messages
  FOR EACH ROW EXECUTE FUNCTION private.stamp_user_activity_timestamps();

DROP TRIGGER IF EXISTS conversation_participants_read_cursor_server_timestamp_before_update ON public.conversation_participants;
CREATE TRIGGER conversation_participants_read_cursor_server_timestamp_before_update
  BEFORE UPDATE OF last_read_at ON public.conversation_participants
  FOR EACH ROW EXECUTE FUNCTION private.stamp_user_activity_timestamps();

DROP TRIGGER IF EXISTS profile_details_activity_server_timestamp_before_write ON public.profile_details;
CREATE TRIGGER profile_details_activity_server_timestamp_before_write
  BEFORE INSERT OR UPDATE ON public.profile_details
  FOR EACH ROW EXECUTE FUNCTION private.stamp_user_activity_timestamps();

COMMIT;
