-- ZannyChat private-media rollout audit (read-only).
-- Run as a trusted database administrator after migration 0009.
-- This does not modify rows or prove Storage RLS behavior. It identifies rows
-- that need manual review before old public URLs are retired.

-- 1) Count messages by media URL state.
select
  case
    when media_url is null or media_url = '' then 'no_media_url'
    when media_url like 'storage://chat-media/%' then 'storage_marker'
    when media_url ~ '/storage/v1/object/public/chat-media/' then 'legacy_public_url_unconverted'
    when media_url ~ '^https?://' then 'other_http_url'
    else 'other_or_malformed_value'
  end as media_url_state,
  count(*) as message_count
from public.messages
where media_url is not null
 group by 1
order by 1;

-- 2) Show legacy URLs whose first object-path segment does not match the
-- message conversation_id, or whose path has query/fragment suffixes. These
-- are intentionally not auto-rewritten by migration 0009.
select
  id as message_id,
  conversation_id,
  media_url,
  case
    when media_url ~ '[?#]' then 'query_or_fragment_requires_manual_review'
    when split_part(
      substring(media_url from '/storage/v1/object/public/chat-media/([^?#]+)'),
      '/', 1
    ) is distinct from conversation_id::text then 'conversation_path_mismatch'
    else 'other_unconverted_legacy_url'
  end as review_reason
from public.messages
where media_url ~ '/storage/v1/object/public/chat-media/'
  and media_url not like 'storage://chat-media/%'
order by conversation_id, id;

-- 3) Detect storage markers whose path does not start with the message's
-- conversation UUID. These rows cannot be repaired safely without context.
select id as message_id, conversation_id, media_url
from public.messages
where media_url like 'storage://chat-media/%'
  and split_part(substring(media_url from '^storage://chat-media/(.*)$'), '/', 1)
      is distinct from conversation_id::text
order by conversation_id, id;


-- 4) Identify malformed internal markers, query/fragment suffixes, and
-- markers whose conversation path does not match the message conversation.
-- This query is read-only; review flagged rows manually.
select
  id as message_id,
  conversation_id,
  media_url,
  case
    when media_url ~ '[?#]' then 'marker_has_query_or_fragment'
    when media_url !~ '^storage://chat-media/[0-9a-fA-F-]{36}/[^?#]+$'
      then 'malformed_marker_shape'
    when split_part(
      substring(media_url from '^storage://chat-media/(.*)$'),
      '/', 1
    ) is distinct from conversation_id::text
      then 'marker_conversation_mismatch'
  end as review_reason
from public.messages
where media_url like 'storage://chat-media/%'
  and (
    media_url ~ '[?#]'
    or media_url !~ '^storage://chat-media/[0-9a-fA-F-]{36}/[^?#]+$'
    or split_part(
      substring(media_url from '^storage://chat-media/(.*)$'),
      '/', 1
    ) is distinct from conversation_id::text
  )
order by conversation_id, id;
