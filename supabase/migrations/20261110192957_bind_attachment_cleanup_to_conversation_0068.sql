-- Bind attachment cleanup candidates to the conversation that owned the message.
-- This is additive and preserves all existing queue rows. Legacy queue rows have
-- no trustworthy conversation binding and the worker will safely skip them.
alter table public.message_attachment_cleanup
  add column if not exists conversation_id uuid;

create index if not exists message_attachment_cleanup_conversation_idx
  on public.message_attachment_cleanup(conversation_id, status, next_attempt_at);

-- The trigger runs only after a message is detached/deleted. Capture the
-- conversation ID while OLD is still available; the worker must verify the
-- object path is rooted under this exact conversation before Storage deletion.
create or replace function public.queue_detached_message_media()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if tg_op = 'DELETE' then
    if old.media_url is not null then
      insert into public.message_attachment_cleanup(message_id, conversation_id, media_url)
      values (old.id, old.conversation_id, old.media_url);
    end if;
    return old;
  end if;

  if old.media_url is not null and new.media_url is distinct from old.media_url then
    insert into public.message_attachment_cleanup(message_id, conversation_id, media_url)
    values (old.id, old.conversation_id, old.media_url);
  end if;
  return new;
end;
$$;

revoke all on function public.queue_detached_message_media() from public, anon, authenticated;
comment on column public.message_attachment_cleanup.conversation_id is
  'Conversation that owned the message when media was detached; worker requires the storage object path to begin with this ID.';
