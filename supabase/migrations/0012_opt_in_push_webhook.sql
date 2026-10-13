-- Do not send message events to a hosted backend unless a database owner
-- explicitly configures both app.backend_url and app.webhook_secret.
-- This forward migration also repairs databases that already applied 0006.
-- Push notifications are opt-in per database. If no backend URL and
-- webhook secret are configured, do not make any outbound HTTP request.
create or replace function public.notify_new_message()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog
as $$
declare
  backend_url text;
  webhook_secret text;
begin
  backend_url := nullif(current_setting('app.backend_url', true), '');
  webhook_secret := nullif(current_setting('app.webhook_secret', true), '');

  -- Local UI/database development should never silently notify a hosted
  -- service. Explicitly configure both values for a dedicated dev/staging
  -- backend when push integration testing is intended.
  if backend_url is null or webhook_secret is null then
    return new;
  end if;

  if backend_url !~ '^https?://' then
    return new;
  end if;

  perform net.http_post(
    url := rtrim(backend_url, '/') || '/webhooks/new-message',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'Authorization', 'Bearer ' || webhook_secret
    ),
    body := jsonb_build_object(
      'messageId', new.id,
      'conversationId', new.conversation_id,
      'senderId', new.sender_id,
      'text', new.text,
      'mediaType', new.media_type
    )
  );
  return new;
end;
$$;

-- Optional explicit configuration for a dedicated development/staging backend:
-- ALTER DATABASE postgres SET app.backend_url = 'https://your-dev-backend.example.com';
-- ALTER DATABASE postgres SET app.webhook_secret = 'replace-with-a-long-random-secret';
-- Open a new SQL session after changing database settings.
