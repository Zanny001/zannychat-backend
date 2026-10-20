-- Per-message device receipt: recipient records delivery when the message
-- is fetched/received by their authenticated client. This is distinct from read.
create table if not exists public.message_delivery_receipts (
  message_id uuid not null references public.messages(id) on delete cascade,
  conversation_id uuid not null references public.conversations(id) on delete cascade,
  user_id uuid not null references public.profiles(id) on delete cascade,
  delivered_at timestamptz not null default now(),
  primary key (message_id, user_id)
);

create index if not exists message_delivery_receipts_conversation_idx
  on public.message_delivery_receipts(conversation_id, delivered_at);

alter table public.message_delivery_receipts enable row level security;
revoke all on public.message_delivery_receipts from public, anon;
grant select, insert on public.message_delivery_receipts to authenticated;

create policy "Participants can read delivery receipts in their conversations"
  on public.message_delivery_receipts for select to authenticated
  using (private.is_conversation_participant(conversation_id));

create policy "Recipients can acknowledge delivery of incoming messages"
  on public.message_delivery_receipts for insert to authenticated
  with check (
    user_id = (select auth.uid())
    and private.is_conversation_participant(conversation_id)
    and exists (
      select 1 from public.messages m
      where m.id = message_id
        and m.conversation_id = message_delivery_receipts.conversation_id
        and m.sender_id <> (select auth.uid())
    )
  );

alter publication supabase_realtime add table public.message_delivery_receipts;
