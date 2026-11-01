# Backend release 1.2.52

## Delivery receipt visibility hardening

- Replaces the broad conversation-participant receipt-read policy.
- Authenticated users can read their own delivery receipt rows.
- The sender of a message can read delivery receipts for that message, provided they remain a participant in the conversation.
- Receipt insertion rules and server-generated delivery timestamps are unchanged.

## Deployment

Apply the forward-only Supabase migration `0054_delivery_receipt_visibility.sql` before relying on the new policy. This source release does not apply SQL to a live project.
