-- Run as a database owner after migrations 0001-0008.
-- Checks function privileges and the guards that prevent arbitrary probing.
do $$
declare
  function_definition text;
begin
  if has_function_privilege('anon', 'public.is_blocked_in_conversation(uuid,uuid)', 'EXECUTE') then
    raise exception 'anon unexpectedly has EXECUTE on is_blocked_in_conversation';
  end if;
  if not has_function_privilege('authenticated', 'public.is_blocked_in_conversation(uuid,uuid)', 'EXECUTE') then
    raise exception 'authenticated is missing EXECUTE needed by the messages INSERT policy';
  end if;

  select pg_get_functiondef('public.is_blocked_in_conversation(uuid,uuid)'::regprocedure)
    into function_definition;
  if position('p_sender_id = auth.uid()' in function_definition) = 0 then
    raise exception 'block-status helper does not restrict sender_id to auth.uid()';
  end if;
  if position('own.conversation_id = p_conversation_id' in function_definition) = 0
     or position('own.user_id = auth.uid()' in function_definition) = 0 then
    raise exception 'block-status helper does not require caller membership in the conversation';
  end if;
  if position('security definer' in lower(function_definition)) = 0 then
    raise exception 'block-status helper must remain SECURITY DEFINER for RLS policy use';
  end if;
end;
$$;

select '0008 block-status probe guard checks passed' as result;
