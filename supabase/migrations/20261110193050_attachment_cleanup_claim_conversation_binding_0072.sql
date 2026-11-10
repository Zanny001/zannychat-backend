-- Return the conversation binding required by the attachment cleanup worker.
-- Migration 0068 adds this column and updates the queue trigger.

drop function if exists public.claim_message_attachment_cleanup(integer);

create function public.claim_message_attachment_cleanup(p_limit integer default 20)
returns table(
  id bigint,
  message_id uuid,
  conversation_id uuid,
  media_url text,
  attempt_count integer
)
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
begin
  return query
  with candidates as (
    select q.id
    from public.message_attachment_cleanup q
    where (q.status = 'pending' and q.next_attempt_at <= now())
       or (
         q.status = 'processing'
         and q.lease_started_at < now() - interval '10 minutes'
       )
    order by q.next_attempt_at, q.id
    for update skip locked
    limit greatest(1, least(coalesce(p_limit, 20), 100))
  )
  update public.message_attachment_cleanup q
     set status = 'processing',
         lease_started_at = now()
    from candidates c
   where q.id = c.id
  returning q.id, q.message_id, q.conversation_id, q.media_url, q.attempt_count;
end;
$$;

revoke all on function public.claim_message_attachment_cleanup(integer)
  from public, anon, authenticated;

grant execute on function public.claim_message_attachment_cleanup(integer)
  to service_role;
