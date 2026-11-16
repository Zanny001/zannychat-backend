-- Correctly dispatch server timestamp stamping for every attached activity table.
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
  IF TG_TABLE_NAME IN (
    'blocked_users',
    'muted_status_users',
    'reports',
    'status_audience_recipients',
    'status_excluded_users',
    'status_replies',
    'message_reactions'
  ) THEN
    NEW.created_at := v_now;
  ELSIF TG_TABLE_NAME = 'status_views' THEN
    NEW.viewed_at := v_now;
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
    IF NEW.last_read_at IS NOT NULL AND NEW.last_read_at IS DISTINCT FROM OLD.last_read_at THEN
      NEW.last_read_at := v_now;
    END IF;
  ELSIF TG_TABLE_NAME = 'push_tokens' THEN
    NEW.updated_at := v_now;
  ELSIF TG_TABLE_NAME = 'user_presence_sessions' THEN
    NEW.last_active_at := v_now;
    NEW.updated_at := v_now;
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
  ELSE
    RAISE EXCEPTION 'unsupported activity timestamp trigger table: %', TG_TABLE_NAME;
  END IF;

  RETURN NEW;
END;
$function$;

REVOKE ALL ON FUNCTION private.stamp_user_activity_timestamps()
  FROM PUBLIC, anon, authenticated;

COMMIT;
