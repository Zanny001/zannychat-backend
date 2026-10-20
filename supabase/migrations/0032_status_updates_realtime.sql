-- Enable authenticated status-feed clients to refresh when visible status rows change.
-- RLS on status_updates remains the authority for which rows a client can receive.
do $$
begin
  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime'
      and schemaname = 'public'
      and tablename = 'status_updates'
  ) then
    alter publication supabase_realtime add table public.status_updates;
  end if;
end $$;
