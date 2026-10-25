-- Aggregate feed statistics in PostgreSQL instead of transferring every reaction,
-- comment and view row to the API process. This avoids PostgREST row-cap undercounts.
create or replace function public.get_channel_post_stats(p_post_ids uuid[], p_user_id uuid)
returns table (
  post_id uuid,
  reaction_counts jsonb,
  my_reaction text,
  comment_count bigint,
  view_count bigint
)
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
begin
  if p_post_ids is null or coalesce(array_length(p_post_ids, 1), 0) < 1
     or array_length(p_post_ids, 1) > 100 or p_user_id is null then
    raise exception 'post ids must contain 1 to 100 values and user id is required';
  end if;

  return query
  with requested as (
    select distinct unnest(p_post_ids) as id
  ), reaction_totals as (
    select r.post_id, jsonb_object_agg(r.emoji, r.total) as counts
    from (
      select cpr.post_id, cpr.emoji, count(*)::bigint as total
      from public.channel_post_reactions cpr
      join requested req on req.id = cpr.post_id
      group by cpr.post_id, cpr.emoji
    ) r
    group by r.post_id
  ), my_reactions as (
    select cpr.post_id, cpr.emoji
    from public.channel_post_reactions cpr
    join requested req on req.id = cpr.post_id
    where cpr.user_id = p_user_id
  ), comment_totals as (
    select cpc.post_id, count(*)::bigint as total
    from public.channel_post_comments cpc
    join requested req on req.id = cpc.post_id
    group by cpc.post_id
  ), view_totals as (
    select cpv.post_id, count(*)::bigint as total
    from public.channel_post_views cpv
    join requested req on req.id = cpv.post_id
    group by cpv.post_id
  )
  select req.id,
         coalesce(rt.counts, '{}'::jsonb),
         mr.emoji,
         coalesce(ct.total, 0),
         coalesce(vt.total, 0)
  from requested req
  left join reaction_totals rt on rt.post_id = req.id
  left join my_reactions mr on mr.post_id = req.id
  left join comment_totals ct on ct.post_id = req.id
  left join view_totals vt on vt.post_id = req.id;
end;
$$;

revoke all on function public.get_channel_post_stats(uuid[], uuid) from public, anon, authenticated;
grant execute on function public.get_channel_post_stats(uuid[], uuid) to service_role;
