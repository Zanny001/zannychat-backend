# Message delivery receipts — backend 1.2.18

Migration `0031_message_delivery_receipts.sql` adds a unique per-message/per-recipient acknowledgement, conversation index, realtime publication, participant-scoped SELECT policy, and self-only INSERT policy that requires the referenced message to be authored by another participant.

Apply migrations in order, after `0030_push_receipt_tracking.sql`. Verify with two authenticated test users that the recipient can acknowledge an incoming message, the sender can read the receipt, a nonparticipant cannot read it, and users cannot create receipts for their own messages or for another user's identity.

This is source-only. No live database migration, RLS integration test, deployment, or physical-device test has been performed.
