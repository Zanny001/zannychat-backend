-- Follow-up to 0065/0066: scrub every message payload field that can reveal
-- attachment/contact metadata when a sender retracts a message for everyone.
-- The media_url transition still fires 0066's reference-safe cleanup queue trigger.
create or replace function public.delete_message(p_message_id uuid, p_mode text)
returns void
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_user_id uuid := auth.uid();
  v_message public.messages%rowtype;
begin
  if v_user_id is null then
    raise exception 'Authentication required' using errcode = '42501';
  end if;
  if p_mode not in ('me', 'everyone') then
    raise exception 'Invalid deletion mode' using errcode = '22023';
  end if;

  select * into v_message
  from public.messages
  where id = p_message_id
    and exists (
      select 1 from public.conversation_participants cp
      where cp.conversation_id = messages.conversation_id
        and cp.user_id = v_user_id
    )
  for update;

  if not found then
    raise exception 'Message not found' using errcode = 'P0002';
  end if;

  if p_mode = 'me' then
    insert into public.message_hidden_for(message_id, user_id)
    values (p_message_id, v_user_id)
    on conflict (message_id, user_id) do nothing;
    return;
  end if;

  if v_message.sender_id <> v_user_id then
    raise exception 'Only the sender can delete a message for everyone' using errcode = '42501';
  end if;

  update public.messages
  set deleted_at = coalesce(deleted_at, now()),
      text = '',
      media_url = null,
      media_type = null,
      media_name = null,
      media_size = null,
      media_duration = null,
      shared_user_id = null
  where id = p_message_id;
end;
$$;
revoke all on function public.delete_message(uuid, text) from public, anon;
grant execute on function public.delete_message(uuid, text) to authenticated;
