-- Private channels are hidden from the directory and require membership to read.
alter table public.channels
  add column if not exists is_private boolean not null default false;

create table if not exists public.channel_invites (
  id uuid primary key default gen_random_uuid(),
  channel_id uuid not null references public.channels(id) on delete cascade,
  created_by uuid not null references public.profiles(id) on delete cascade,
  token_hash text not null unique check (char_length(token_hash) = 64),
  max_uses integer not null default 50 check (max_uses between 1 and 500),
  use_count integer not null default 0 check (use_count >= 0 and use_count <= max_uses),
  expires_at timestamptz not null,
  revoked_at timestamptz,
  created_at timestamptz not null default now()
);
create index if not exists channel_invites_channel_recent_idx
  on public.channel_invites (channel_id, created_at desc);

alter table public.channel_invites enable row level security;
revoke all on public.channel_invites from public, anon, authenticated;
grant select, insert, update, delete on public.channel_invites to service_role;

-- Consume invite + join atomically so concurrent accept requests cannot exceed max_uses.
create or replace function public.accept_channel_invite(p_token_hash text, p_user_id uuid)
returns table(channel_id uuid, owner_id uuid, title text, description text, is_private boolean)
language plpgsql
security definer
set search_path = public
as $$
declare
  invite_row public.channel_invites%rowtype;
  channel_row public.channels%rowtype;
  inserted_count integer := 0;
begin
  select * into invite_row
  from public.channel_invites
  where token_hash = p_token_hash
  for update;

  if not found or invite_row.revoked_at is not null or invite_row.expires_at <= now()
     or invite_row.use_count >= invite_row.max_uses then
    return;
  end if;

  select * into channel_row from public.channels where id = invite_row.channel_id;
  if not found then return; end if;

  insert into public.channel_subscriptions (channel_id, user_id)
  values (channel_row.id, p_user_id)
  on conflict (channel_id, user_id) do nothing;
  get diagnostics inserted_count = row_count;

  -- Re-accepting an invite as an existing member is idempotent and consumes no extra slot.
  if inserted_count > 0 then
    update public.channel_invites set use_count = use_count + 1 where id = invite_row.id;
  end if;
  return query select channel_row.id, channel_row.owner_id, channel_row.title,
    channel_row.description, channel_row.is_private;
end;
$$;
revoke all on function public.accept_channel_invite(text, uuid) from public, anon, authenticated;
grant execute on function public.accept_channel_invite(text, uuid) to service_role;
