-- Multi-select polls: one voter may choose multiple options, while the server
-- still enforces membership, option ownership, open/closed state, and bounds.
alter table public.polls
  add column if not exists allow_multiple boolean not null default false;

-- Replace the single-option-per-voter key with one vote per option per voter.
alter table public.poll_votes drop constraint if exists poll_votes_pkey;
alter table public.poll_votes add constraint poll_votes_pkey primary key (poll_id, user_id, option_id);

-- Replace the array RPC and retain a single-choice wrapper for older clients.
drop function if exists public.cast_poll_vote(uuid, uuid);
drop function if exists public.cast_poll_vote(uuid, uuid[]);
create function public.cast_poll_vote(p_poll_id uuid, p_option_ids uuid[])
returns void language plpgsql security definer set search_path = public, pg_temp as $$
declare v_user_id uuid := auth.uid(); v_allow_multiple boolean; v_option_count integer;
begin
  if v_user_id is null then raise exception 'Authentication required'; end if;
  if p_option_ids is null or cardinality(p_option_ids) < 1 or cardinality(p_option_ids) > 10 then
    raise exception 'Choose between 1 and 10 poll options';
  end if;
  if (select count(distinct x) from unnest(p_option_ids) x) <> cardinality(p_option_ids) then
    raise exception 'Poll options must be unique';
  end if;
  select p.allow_multiple into v_allow_multiple
    from public.polls p join public.conversation_participants cp on cp.conversation_id = p.conversation_id
    where p.id = p_poll_id and cp.user_id = v_user_id and (p.closes_at is null or p.closes_at > now());
  if not found then raise exception 'Poll is closed or unavailable'; end if;
  if not v_allow_multiple and cardinality(p_option_ids) <> 1 then
    raise exception 'This poll accepts only one option';
  end if;
  select count(*) into v_option_count from public.poll_options o where o.poll_id = p_poll_id and o.id = any(p_option_ids);
  if v_option_count <> cardinality(p_option_ids) then raise exception 'Invalid poll option'; end if;
  delete from public.poll_votes where poll_id = p_poll_id and user_id = v_user_id;
  insert into public.poll_votes(poll_id, option_id, user_id)
    select p_poll_id, selected.option_id, v_user_id from unnest(p_option_ids) as selected(option_id);
end; $$;
revoke all on function public.cast_poll_vote(uuid, uuid[]) from public, anon;
grant execute on function public.cast_poll_vote(uuid, uuid[]) to authenticated;
create function public.cast_poll_vote(p_poll_id uuid, p_option_id uuid)
returns void language sql security definer set search_path = public, pg_temp as $$
  select public.cast_poll_vote(p_poll_id, array[p_option_id]::uuid[]);
$$;
revoke all on function public.cast_poll_vote(uuid, uuid) from public, anon;
grant execute on function public.cast_poll_vote(uuid, uuid) to authenticated;

-- Extend atomic creation with an explicit multi-select flag.
drop function if exists public.create_conversation_poll(uuid, text, text[], timestamptz);
create function public.create_conversation_poll(
  p_conversation_id uuid, p_question text, p_options text[],
  p_closes_at timestamptz, p_allow_multiple boolean
) returns uuid language plpgsql security definer set search_path = public, pg_temp as $$
declare v_poll_id uuid; v_option text; v_position integer := 0; v_question text := btrim(coalesce(p_question, ''));
begin
  if auth.uid() is null then raise exception 'Authentication required'; end if;
  if char_length(v_question) not between 1 and 240 then raise exception 'Question must be 1-240 characters'; end if;
  if p_options is null or cardinality(p_options) not between 2 and 10 then raise exception 'Provide 2-10 options'; end if;
  if p_closes_at is not null and p_closes_at <= now() then raise exception 'Poll closing time must be in the future'; end if;
  if not exists (select 1 from public.conversation_participants cp where cp.conversation_id = p_conversation_id and cp.user_id = auth.uid()) then raise exception 'Conversation membership required'; end if;
  if exists (select 1 from unnest(p_options) x where char_length(btrim(coalesce(x, ''))) not between 1 and 120) then raise exception 'Each option must be 1-120 characters'; end if;
  if (select count(distinct lower(btrim(x))) from unnest(p_options) x) <> cardinality(p_options) then raise exception 'Options must be unique'; end if;
  insert into public.polls(conversation_id, creator_id, question, closes_at, allow_multiple)
    values (p_conversation_id, auth.uid(), v_question, p_closes_at, coalesce(p_allow_multiple, false)) returning id into v_poll_id;
  foreach v_option in array p_options loop
    insert into public.poll_options(poll_id, label, position) values (v_poll_id, btrim(v_option), v_position);
    v_position := v_position + 1;
  end loop;
  return v_poll_id;
end; $$;
revoke all on function public.create_conversation_poll(uuid, text, text[], timestamptz, boolean) from public, anon;
grant execute on function public.create_conversation_poll(uuid, text, text[], timestamptz, boolean) to authenticated;
create function public.create_conversation_poll(p_conversation_id uuid, p_question text, p_options text[], p_closes_at timestamptz default null)
returns uuid language sql security definer set search_path = public, pg_temp as $$
  select public.create_conversation_poll(p_conversation_id, p_question, p_options, p_closes_at, false);
$$;
revoke all on function public.create_conversation_poll(uuid, text, text[], timestamptz) from public, anon;
grant execute on function public.create_conversation_poll(uuid, text, text[], timestamptz) to authenticated;

-- Return aggregate counts and only the caller's own selected-option state;
-- no voter identities are exposed to the client.
drop function if exists public.get_poll_vote_counts_for_ids(uuid, uuid[]);
create function public.get_poll_vote_counts_for_ids(p_conversation_id uuid, p_poll_ids uuid[])
returns table(poll_id uuid, option_id uuid, vote_count bigint, selected_by_me boolean, voter_count bigint)
language plpgsql security definer set search_path = public, pg_temp as $$
declare v_user_id uuid := auth.uid();
begin
  if v_user_id is null then raise exception 'Authentication required'; end if;
  if p_conversation_id is null then raise exception 'Conversation is required'; end if;
  if p_poll_ids is null or cardinality(p_poll_ids) < 1 or cardinality(p_poll_ids) > 100 then raise exception 'Poll IDs must contain between 1 and 100 items'; end if;
  if not exists (select 1 from public.conversation_participants cp where cp.conversation_id = p_conversation_id and cp.user_id = v_user_id) then raise exception 'Conversation membership required'; end if;
  if exists (select 1 from unnest(p_poll_ids) requested(poll_id) where not exists (select 1 from public.polls p where p.id = requested.poll_id and p.conversation_id = p_conversation_id)) then raise exception 'All polls must belong to the requested conversation'; end if;
  return query
    with per_poll as (
      select v.poll_id, count(distinct v.user_id)::bigint as voter_count
      from public.poll_votes v join public.polls p on p.id = v.poll_id
      where p.conversation_id = p_conversation_id and p.id = any(p_poll_ids)
      group by v.poll_id
    )
    select p.id, o.id, count(v.user_id)::bigint,
      coalesce(bool_or(v.user_id = v_user_id), false), coalesce(pp.voter_count, 0)::bigint
    from public.polls p join public.poll_options o on o.poll_id = p.id
    left join public.poll_votes v on v.poll_id = p.id and v.option_id = o.id
    left join per_poll pp on pp.poll_id = p.id
    where p.conversation_id = p_conversation_id and p.id = any(p_poll_ids)
    group by p.id, o.id, o.position, pp.voter_count
    order by p.id, o.position;
end; $$;
revoke all on function public.get_poll_vote_counts_for_ids(uuid, uuid[]) from public, anon;
grant execute on function public.get_poll_vote_counts_for_ids(uuid, uuid[]) to authenticated;
