-- ZannyChat — initial schema
-- Run this in the Supabase project's SQL editor, or via the Supabase CLI:
--   supabase db push
--
-- Design notes:
--   * profiles/conversations/conversation_participants/messages match
--     exactly what src/services/api.js in the frontend already expects.
--   * RLS is on for every table. Clients (the mobile app) only ever get
--     the anon key, so every read/write is filtered by these policies.
--   * The wallet/ledger tables exist for the Phase 2 preview only — no
--     insert policy is granted to authenticated users, so balances can
--     ONLY change through the backend's service-role key (i.e. through
--     reviewed server code: webhooks or the /wallet/transfer endpoint),
--     never directly from the app.

create extension if not exists "pgcrypto";

-- ---------------------------------------------------------------------
-- PROFILES
-- ---------------------------------------------------------------------
create table if not exists public.profiles (
  id uuid primary key references auth.users (id) on delete cascade,
  name text not null default 'New user',
  avatar_color text not null default '#6C5CE7',
  status text default 'Hey there, I''m using ZannyChat',
  online boolean not null default false,
  created_at timestamptz not null default now()
);

alter table public.profiles enable row level security;

create policy "Profiles are viewable by any signed-in user"
  on public.profiles for select
  to authenticated
  using (true);

create policy "Users can update their own profile"
  on public.profiles for update
  to authenticated
  using (auth.uid() = id);

-- Auto-create a profile row whenever someone signs up via Supabase Auth.
create or replace function public.handle_new_user()
returns trigger as $$
begin
  insert into public.profiles (id, name)
  values (new.id, coalesce(new.raw_user_meta_data ->> 'name', split_part(new.email, '@', 1)));
  return new;
end;
$$ language plpgsql security definer set search_path = public;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute procedure public.handle_new_user();

-- ---------------------------------------------------------------------
-- CONVERSATIONS
-- ---------------------------------------------------------------------
create table if not exists public.conversations (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now()
);

create table if not exists public.conversation_participants (
  conversation_id uuid references public.conversations (id) on delete cascade,
  user_id uuid references public.profiles (id) on delete cascade,
  joined_at timestamptz not null default now(),
  primary key (conversation_id, user_id)
);

alter table public.conversations enable row level security;
alter table public.conversation_participants enable row level security;

create policy "Members can view their conversations"
  on public.conversations for select
  to authenticated
  using (
    exists (
      select 1 from public.conversation_participants cp
      where cp.conversation_id = id and cp.user_id = auth.uid()
    )
  );

create policy "Members can view fellow participants"
  on public.conversation_participants for select
  to authenticated
  using (
    exists (
      select 1 from public.conversation_participants cp2
      where cp2.conversation_id = conversation_participants.conversation_id
        and cp2.user_id = auth.uid()
    )
  );

-- ---------------------------------------------------------------------
-- MESSAGES
-- ---------------------------------------------------------------------
create table if not exists public.messages (
  id uuid primary key default gen_random_uuid(),
  conversation_id uuid not null references public.conversations (id) on delete cascade,
  sender_id uuid not null references public.profiles (id) on delete cascade,
  text text not null,
  reply_to_id uuid references public.messages (id),
  created_at timestamptz not null default now()
);

alter table public.messages enable row level security;

create policy "Members can read messages in their conversations"
  on public.messages for select
  to authenticated
  using (
    exists (
      select 1 from public.conversation_participants cp
      where cp.conversation_id = messages.conversation_id and cp.user_id = auth.uid()
    )
  );

create policy "Members can send messages in their conversations"
  on public.messages for insert
  to authenticated
  with check (
    sender_id = auth.uid()
    and exists (
      select 1 from public.conversation_participants cp
      where cp.conversation_id = messages.conversation_id and cp.user_id = auth.uid()
    )
  );

-- Turns on Supabase Realtime for new messages (used by
-- subscribeToMessages in src/services/api.js on the frontend).
alter publication supabase_realtime add table public.messages;

-- ---------------------------------------------------------------------
-- WALLET / LEDGER — Phase 2 preview
-- Internal balances only. No payment provider is wired up yet; this
-- just gives the backend something real to compute against once one is.
-- ---------------------------------------------------------------------
create table if not exists public.wallets (
  user_id uuid primary key references public.profiles (id) on delete cascade,
  currency text not null default 'NGN',
  created_at timestamptz not null default now()
);

create table if not exists public.ledger_entries (
  id uuid primary key default gen_random_uuid(),
  wallet_id uuid not null references public.wallets (user_id) on delete cascade,
  amount numeric(14, 2) not null, -- positive = credit, negative = debit
  reason text not null,
  reference text,
  created_at timestamptz not null default now()
);

alter table public.wallets enable row level security;
alter table public.ledger_entries enable row level security;

create policy "Users can view their own wallet"
  on public.wallets for select
  to authenticated
  using (auth.uid() = user_id);

create policy "Users can view their own ledger entries"
  on public.ledger_entries for select
  to authenticated
  using (auth.uid() = wallet_id);

-- Deliberately no insert/update policies for authenticated users:
-- balances can only move via the backend's service-role key.

create or replace function public.get_wallet_balance(p_user_id uuid)
returns numeric as $$
  select coalesce(sum(amount), 0)
  from public.ledger_entries
  where wallet_id = p_user_id;
$$ language sql stable;

-- Give every new profile a zero-balance wallet automatically.
create or replace function public.handle_new_profile()
returns trigger as $$
begin
  insert into public.wallets (user_id) values (new.id)
  on conflict (user_id) do nothing;
  return new;
end;
$$ language plpgsql security definer set search_path = public;

drop trigger if exists on_profile_created on public.profiles;
create trigger on_profile_created
  after insert on public.profiles
  for each row execute procedure public.handle_new_profile();
