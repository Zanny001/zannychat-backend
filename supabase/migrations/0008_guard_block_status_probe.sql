-- ZannyChat — prevent direct probing of other users' block relationships.
-- The SECURITY DEFINER helper is used by the messages INSERT RLS policy.
-- Because authenticated users can also call exposed SQL functions through
-- PostgREST, its inputs must be constrained to the caller's own identity and
-- conversations they participate in.

create or replace function public.is_blocked_in_conversation(p_conversation_id uuid, p_sender_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select
    p_sender_id = auth.uid()
    and exists (
      select 1
      from public.conversation_participants own
      where own.conversation_id = p_conversation_id
        and own.user_id = auth.uid()
    )
    and exists (
      select 1
      from public.conversation_participants cp
      join public.blocked_users b
        on b.blocker_id = cp.user_id
       and b.blocked_id = p_sender_id
      where cp.conversation_id = p_conversation_id
        and cp.user_id <> p_sender_id
    );
$$;

-- Only authenticated callers need this function for the INSERT policy.
-- The function remains callable by authenticated users, but its body now
-- refuses arbitrary sender IDs and conversations where they are not members.
revoke all on function public.is_blocked_in_conversation(uuid, uuid) from PUBLIC, anon, authenticated;
grant execute on function public.is_blocked_in_conversation(uuid, uuid) to authenticated;
