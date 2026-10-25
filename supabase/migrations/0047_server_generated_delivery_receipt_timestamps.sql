-- Delivery timestamps are evidence of server receipt recording, not client claims.
-- Always replace any client-supplied delivered_at value with database time.
create or replace function private.enforce_message_delivery_receipt_timestamp()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.delivered_at := pg_catalog.now();
  return new;
end;
$$;

revoke all on function private.enforce_message_delivery_receipt_timestamp() from public, anon, authenticated;

drop trigger if exists message_delivery_receipts_server_timestamp on public.message_delivery_receipts;
create trigger message_delivery_receipts_server_timestamp
before insert on public.message_delivery_receipts
for each row execute function private.enforce_message_delivery_receipt_timestamp();
