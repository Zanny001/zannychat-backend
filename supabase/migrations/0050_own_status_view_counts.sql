-- Aggregate status view receipts without exposing individual viewer rows.
-- Only the authenticated owner of each status can retrieve its count.
create or replace function public.get_own_status_view_counts(p_status_ids uuid[])
returns table(status_id uuid, view_count bigint)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_user_id uuid := auth.uid();
begin
  if v_user_id is null then
    raise exception 'Authentication required' using errcode = '42501';
  end if;
  if p_status_ids is null or cardinality(p_status_ids) = 0 or cardinality(p_status_ids) > 200 then
    raise exception 'Provide between 1 and 200 status IDs' using errcode = '22023';
  end if;

  return query
    select s.id, count(v.viewer_id)::bigint
    from (select distinct unnest(p_status_ids) as id) requested
    join public.status_updates s on s.id = requested.id and s.user_id = v_user_id
    left join public.status_views v on v.status_id = s.id
    group by s.id;
end;
$$;

revoke all on function public.get_own_status_view_counts(uuid[]) from public, anon;
revoke all on function public.get_own_status_view_counts(uuid[]) from authenticated;
grant execute on function public.get_own_status_view_counts(uuid[]) to authenticated;
