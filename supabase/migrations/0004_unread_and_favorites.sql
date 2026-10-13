-- ZannyChat — real unread counts, read receipts, and favorites
-- Run after 0001, 0002, and 0003, same way (Supabase SQL editor or
-- `supabase db push`).
--
-- Prompted by reviewing a separate reference chat app: its Mongo
-- schema tracked a per-participant unread counter and a per-message
-- delivery status directly. Adapted here to Postgres/RLS rather than
-- copied — a single `last_read_at` timestamp per participant is more
-- robust than a mutable counter (it can't drift out of sync from a
-- missed decrement, and both unread count AND read-receipt state are
-- derived from the same one value by comparing timestamps, instead of
-- needing two separate mutable fields that could disagree).

alter table public.conversation_participants
  add column if not exists last_read_at timestamptz,
  add column if not exists is_favorite boolean not null default false;

-- conversation_participants had a SELECT policy from 0001 but no
-- UPDATE policy at all — meaning any attempt to write last_read_at or
-- is_favorite would have silently failed under RLS's default-deny.
-- Scoped so you can only ever update your OWN participant row, never
-- someone else's read state or favorite flag.
create policy "Users can update their own participant row"
  on public.conversation_participants for update
  to authenticated
  using (user_id = auth.uid())
  with check (user_id = auth.uid());

-- Lets the frontend subscribe to a live "seen" tick — when the other
-- participant's last_read_at changes, Realtime pushes that update
-- immediately, the same mechanism already used for new messages.
alter publication supabase_realtime add table public.conversation_participants;
