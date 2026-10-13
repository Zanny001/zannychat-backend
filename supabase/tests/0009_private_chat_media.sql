-- Catalog assertions for migrations 0009-0010 plus manual checks for private media. Run with suitable test users.
-- SQL assertions for bucket and policy configuration.
do $$
declare
  is_public boolean;
  participant_policy_count integer;
  public_policy_count integer;
begin
  select public into is_public from storage.buckets where id = 'chat-media';
  if is_public is distinct from false then
    raise exception 'chat-media bucket must be private';
  end if;

  select count(*) into participant_policy_count
  from pg_policies
  where schemaname = 'storage' and tablename = 'objects'
    and policyname = 'Chat media is readable by conversation participants'
    and cmd = 'SELECT';
  if participant_policy_count <> 1 then
    raise exception 'expected participant-scoped chat media SELECT policy';
  end if;

  select count(*) into public_policy_count
  from pg_policies
  where schemaname = 'storage' and tablename = 'objects'
    and policyname = 'Chat media is readable by anyone with the link';
  if public_policy_count <> 0 then
    raise exception 'legacy public chat media policy still exists';
  end if;

  if not exists (
    select 1 from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'private'
      and p.proname = 'is_chat_media_conversation_member'
      and p.prosecdef
  ) then
    raise exception 'expected SECURITY DEFINER private chat-media policy helper';
  end if;

  if has_function_privilege('anon', 'private.is_chat_media_conversation_member(text)', 'EXECUTE') then
    raise exception 'anonymous role must not execute chat-media policy helper';
  end if;

  if not exists (
    select 1 from pg_policies
    where schemaname = 'storage'
      and tablename = 'objects'
      and policyname = 'Chat media is readable by conversation participants'
      and qual like '%is_chat_media_conversation_member%'
  ) then
    raise exception 'chat-media read policy must use non-recursive helper';
  end if;

  if not exists (
    select 1 from pg_policies
    where schemaname = 'storage'
      and tablename = 'objects'
      and policyname = 'Only conversation participants can upload chat media'
      and with_check like '%is_chat_media_conversation_member%'
  ) then
    raise exception 'chat-media upload policy must use non-recursive helper';
  end if;
end $$;

-- Manual integration checks (requires two users and a conversation):
-- 1. User A and B can createSignedUrl/download an object in their conversation.
-- 2. User C cannot create a signed URL or download that object.
-- 3. An anonymous client cannot create a signed URL or download that object.
-- 4. Avatar URLs still work as expected.
-- 5. A message with a legacy public URL was rewritten to storage://chat-media/....
-- 6. Legacy URLs with an object-path conversation UUID different from the
--    message conversation_id remain unchanged for manual review.
-- 7. URLs containing query strings/fragments are not rewritten automatically.
