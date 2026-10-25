-- ZannyChat 1.2.232: harden the terminal-call cleanup trigger for existing installs.
-- Use an empty search_path in SECURITY DEFINER code and qualify every relation.
create or replace function public.cleanup_terminal_call_signals()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.status in ('declined','cancelled','ended','missed','failed')
     and old.status is distinct from new.status then
    delete from public.call_signals where call_id = new.id;
  end if;
  return new;
end;
$$;
