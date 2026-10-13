-- Read-only release gate: run after migrations 0001-0012.
-- Confirms the installed trigger function no longer contains a hosted URL fallback.
do $$
declare
  definition text;
begin
  definition := pg_get_functiondef('public.notify_new_message()'::regprocedure);

  if position('zannychat-backend.onrender.com' in lower(definition)) > 0 then
    raise exception 'notify_new_message still contains a hosted backend fallback';
  end if;
  if position('app.backend_url' in definition) = 0 or position('app.webhook_secret' in definition) = 0 then
    raise exception 'notify_new_message must require explicit backend URL and webhook secret settings';
  end if;
  if position('return new' in lower(definition)) = 0 then
    raise exception 'notify_new_message must no-op safely when push is not configured';
  end if;
end;
$$;
