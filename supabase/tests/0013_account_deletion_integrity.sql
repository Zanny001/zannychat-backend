-- Run after migration 0013 in a non-production test database.
do $$
declare
  reply_fk_delete_action "char";
  cleanup_trigger_enabled boolean;
begin
  select confdeltype into reply_fk_delete_action
  from pg_constraint
  where conrelid = 'public.messages'::regclass
    and conname = 'messages_reply_to_id_fkey';
  if reply_fk_delete_action is distinct from 'n' then
    raise exception 'message reply FK must use ON DELETE SET NULL';
  end if;

  select (tgenabled <> 'D') into cleanup_trigger_enabled
  from pg_trigger
  where tgrelid = 'public.conversation_participants'::regclass
    and tgname = 'cleanup_empty_direct_conversation_after_member_delete'
    and not tgisinternal;
  if cleanup_trigger_enabled is distinct from true then
    raise exception 'direct conversation cleanup trigger missing or disabled';
  end if;

  if not exists (
    select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname = 'cleanup_empty_direct_conversation'
      and p.prosecdef and p.proconfig @> array['search_path=public']
  ) then
    raise exception 'direct conversation cleanup function must be SECURITY DEFINER with pinned search_path';
  end if;
end;
$$;
