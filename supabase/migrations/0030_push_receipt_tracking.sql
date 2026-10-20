-- Persist Expo push tickets so delayed receipts can distinguish accepted
-- notifications from provider-confirmed delivery and later delivery errors.
create table if not exists public.push_receipt_tickets (
  ticket_id text primary key,
  user_id uuid not null references public.profiles(id) on delete cascade,
  expo_push_token text not null,
  receipt_status text not null default 'pending' check (receipt_status in ('pending', 'ok', 'error')),
  receipt_error text,
  sent_at timestamptz not null default now(),
  checked_at timestamptz,
  last_attempted_at timestamptz,
  constraint push_receipt_ticket_id_not_blank check (length(trim(ticket_id)) > 0)
);

create index if not exists push_receipt_tickets_pending_idx
  on public.push_receipt_tickets(sent_at)
  where receipt_status = 'pending';

alter table public.push_receipt_tickets enable row level security;
revoke all on public.push_receipt_tickets from public, anon, authenticated;
grant select, insert, update, delete on public.push_receipt_tickets to service_role;
-- Access is intentionally restricted to the backend service-role client.
