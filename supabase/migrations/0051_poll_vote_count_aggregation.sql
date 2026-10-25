-- Aggregate poll votes inside PostgreSQL instead of transferring voter identities
-- and every vote row to each conversation member. Counts are scoped to membership.
create or replace function public.get_conversation_poll_vote_counts(p_conversation_id uuid)
returns table(poll_id uuid, option_id uuid, vote_count bigint)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare v_user_id uuid := auth.uid();
begin
  if v_user_id is null then raise exception 'Authentication required'; end if;
  if p_conversation_id is null then raise exception 'Conversation is required'; end if;
  if not exists (
    select 1 from public.conversation_participants cp
    where cp.conversation_id = p_conversation_id and cp.user_id = v_user_id
  ) then raise exception 'Conversation membership required'; end if;

  return query
    select p.id, o.id, count(v.user_id)::bigint
    from public.polls p
    join public.poll_options o on o.poll_id = p.id
    left join public.poll_votes v on v.poll_id = p.id and v.option_id = o.id
    where p.conversation_id = p_conversation_id
    group by p.id, o.id;
end;
$$;
revoke all on function public.get_conversation_poll_vote_counts(uuid) from public, anon;
revoke all on function public.get_conversation_poll_vote_counts(uuid) from authenticated;
grant execute on function public.get_conversation_poll_vote_counts(uuid) to authenticated;
