-- Delivery receipt privacy: conversation membership alone does not expose
-- every participant's delivery state. A user can read their own receipt rows;
-- the sender of a message can read the recipient receipts for that message.
drop policy if exists "Participants can read delivery receipts in their conversations"
  on public.message_delivery_receipts;

create policy "Message senders and receipt owners can read delivery receipts"
  on public.message_delivery_receipts for select to authenticated
  using (
    private.is_conversation_participant(conversation_id)
    and (
      user_id = (select auth.uid())
      or exists (
        select 1
        from public.messages m
        where m.id = message_delivery_receipts.message_id
          and m.conversation_id = message_delivery_receipts.conversation_id
          and m.sender_id = (select auth.uid())
      )
    )
  );
