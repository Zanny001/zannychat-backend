-- Aggregate only the visible poll page to keep vote-count queries bounded.
-- Membership is checked server-side and every requested poll must belong to that conversation.
create or replace function public.get_poll_vote_counts_for_ids(
  p_conversation_id uuid,
  p_poll_ids uuid[]
)
returns table(poll_id uuid, option_id uuid, vote_count bigint)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare v_user_id uuid := auth.uid();
begin
  if v_user_id is null then raise exception 'Authentication required'; end if;
  if p_conversation_id is null then raise exception 'Conversation is required'; end if;
  if p_poll_ids is null or cardinality(p_poll_ids) < 1 or cardinality(p_poll_ids) > 100 then
    raise exception 'Poll IDs must contain between 1 and 100 items';
  end if;
  if not exists (
    select 1 from public.conversation_participants cp
    where cp.conversation_id = p_conversation_id and cp.user_id = v_user_id
  ) then raise exception 'Conversation membership required'; end if;
  if exists (
    select 1 from unnest(p_poll_ids) requested(poll_id)
    where not exists (
      select 1 from public.polls p
      where p.id = requested.poll_id and p.conversation_id = p_conversation_id
    )
  ) then raise exception 'All polls must belong to the requested conversation'; end if;

  return query
    select p.id, o.id, count(v.user_id)::bigint
    from public.polls p
    join public.poll_options o on o.poll_id = p.id
    left join public.poll_votes v on v.poll_id = p.id and v.option_id = o.id
    where p.conversation_id = p_conversation_id and p.id = any(p_poll_ids)
    group by p.id, o.id;
end;
$$;
revoke all on function public.get_poll_vote_counts_for_ids(uuid, uuid[]) from public, anon;
revoke all on function public.get_poll_vote_counts_for_ids(uuid, uuid[]) from authenticated;
grant execute on function public.get_poll_vote_counts_for_ids(uuid, uuid[]) to authenticated;
