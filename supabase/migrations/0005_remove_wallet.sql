-- ZannyChat — remove the in-app wallet
-- Run this in the Supabase project's SQL editor, or via the Supabase CLI,
-- after 0001-0004.
--
-- Why: the wallet/ledger in 0001_init.sql was a Phase 2 preview with no
-- real payment provider ever connected (the Stripe webhook stayed a
-- stub throughout). Payments are now a separate, dedicated product —
-- this app is going back to being a chat app, not a "chat + wallet"
-- hybrid. This migration removes that data model entirely rather than
-- just hiding it in the app, so there's no dead schema, no orphaned
-- trigger, and no balance data silently sitting unused.
--
-- Safe to run even if a project never had any ledger activity — every
-- statement below is a plain DROP, nothing here depends on the tables
-- being empty.

-- The trigger that gave every new profile a wallet row — drop it before
-- the function it calls, and before the table it would insert into.
drop trigger if exists on_profile_created on public.profiles;
drop function if exists public.handle_new_profile();

-- Used only by GET /wallet/balance, which no longer exists.
drop function if exists public.get_wallet_balance(uuid);

-- ledger_entries references wallets, so it goes first.
drop table if exists public.ledger_entries;
drop table if exists public.wallets;
