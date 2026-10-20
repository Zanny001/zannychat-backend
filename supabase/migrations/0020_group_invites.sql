-- Revocable, bounded-use group invites. Plain tokens are never stored: only SHA-256 hashes are persisted.
create table if not exists public.group_invites (
  id uuid primary key default gen_random_uuid(),
  conversation_id uuid not null references public.conversations(id) on delete cascade,
  token_hash text not null unique check (length(token_hash) = 64),
  created_by uuid not null references public.profiles(id) on delete cascade,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null,
  max_uses integer not null default 25 check (max_uses between 1 and 100),
  use_count integer not null default 0 check (use_count >= 0),
  revoked_at timestamptz,
  check (expires_at > created_at)
);
create index if not exists group_invites_active_idx on public.group_invites (conversation_id, expires_at) where revoked_at is null;
alter table public.group_invites enable row level security;
revoke all on public.group_invites from anon, authenticated;
grant select, insert, update, delete on public.group_invites to service_role;

create or replace function public.accept_group_invite(p_token_hash text, p_user_id uuid)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare invite_row public.group_invites%rowtype;
begin
  if p_token_hash is null or length(p_token_hash) <> 64 or p_user_id is null then
    raise exception 'invalid_invite';
  end if;
  select * into invite_row from public.group_invites where token_hash = p_token_hash for update;
  if not found or invite_row.revoked_at is not null or invite_row.expires_at <= now() or invite_row.use_count >= invite_row.max_uses then
    raise exception 'invite_unavailable';
  end if;
  if not exists (select 1 from public.conversations c where c.id = invite_row.conversation_id and c.is_group = true) then
    raise exception 'group_unavailable';
  end if;
  if exists (select 1 from public.conversation_participants cp where cp.conversation_id = invite_row.conversation_id and cp.user_id = p_user_id) then
    return invite_row.conversation_id;
  end if;
  insert into public.conversation_participants (conversation_id, user_id, is_admin)
  values (invite_row.conversation_id, p_user_id, false)
  on conflict (conversation_id, user_id) do nothing;
  update public.group_invites set use_count = use_count + 1 where id = invite_row.id;
  return invite_row.conversation_id;
end;
$$;
revoke all on function public.accept_group_invite(text, uuid) from public, anon, authenticated;
grant execute on function public.accept_group_invite(text, uuid) to service_role;
