-- Opt-in phone discovery uses a keyed HMAC index, never a plaintext phone column.
-- The HMAC secret is configured only on the trusted backend as
-- PHONE_DISCOVERY_HMAC_SECRET (>= 32 bytes); do not reuse the Supabase service key.
create table if not exists public.phone_discovery (
  user_id uuid primary key references public.profiles(id) on delete cascade,
  phone_hash text not null unique check (phone_hash ~ '^[0-9a-f]{64}$'),
  discoverable boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.phone_discovery enable row level security;
revoke all on public.phone_discovery from anon, authenticated;
-- No client policies by design. All reads/writes use authenticated backend routes
-- and the server-side service role after verified Supabase Auth checks.
comment on table public.phone_discovery is 'Private HMAC phone lookup index; plaintext phone numbers must never be stored here.';
comment on column public.phone_discovery.phone_hash is 'HMAC-SHA256(E.164 phone, backend-only PHONE_DISCOVERY_HMAC_SECRET).';
