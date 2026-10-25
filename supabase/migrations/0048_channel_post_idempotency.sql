-- Make channel post retries safe when the server commits but the client loses the response.
alter table public.channel_posts
  add column if not exists client_request_id uuid;

create unique index if not exists channel_posts_client_request_unique
  on public.channel_posts (channel_id, author_id, client_request_id)
  where client_request_id is not null;
