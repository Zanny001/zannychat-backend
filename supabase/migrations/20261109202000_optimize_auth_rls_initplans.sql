-- Hoist stable auth.uid() calls out of per-row RLS evaluation.
-- Only rewrites the policies identified by the Supabase auth_rls_initplan
-- advisor; access predicates and roles remain unchanged.
BEGIN;

ALTER POLICY "Users can block other users" ON public.blocked_users
  WITH CHECK (((SELECT auth.uid()) = blocker_id));
ALTER POLICY "Users can unblock from their own list" ON public.blocked_users
  USING (((SELECT auth.uid()) = blocker_id));
ALTER POLICY "Users can view their own block list" ON public.blocked_users
  USING (((SELECT auth.uid()) = blocker_id));

ALTER POLICY "Call participants can read their calls" ON public.call_sessions
  USING ((((SELECT auth.uid()) = caller_id) OR ((SELECT auth.uid()) = callee_id)));
ALTER POLICY "Conversation members can initiate direct calls" ON public.call_sessions
  WITH CHECK ((caller_id = (SELECT auth.uid())));
ALTER POLICY "Participants can transition their call state" ON public.call_sessions
  USING ((((SELECT auth.uid()) = caller_id) OR ((SELECT auth.uid()) = callee_id)))
  WITH CHECK ((((SELECT auth.uid()) = caller_id) OR ((SELECT auth.uid()) = callee_id)));

ALTER POLICY "Call participants can read signaling addressed to them" ON public.call_signals
  USING (
    (((SELECT auth.uid()) = sender_id) OR ((SELECT auth.uid()) = recipient_id))
    AND EXISTS (
      SELECT 1 FROM public.call_sessions AS c
      WHERE c.id = call_signals.call_id
        AND (((SELECT auth.uid()) = c.caller_id) OR ((SELECT auth.uid()) = c.callee_id))
    )
  );
ALTER POLICY "Participants can send signaling to the other participant" ON public.call_signals
  WITH CHECK (
    sender_id = (SELECT auth.uid())
    AND EXISTS (
      SELECT 1 FROM public.call_sessions AS c
      WHERE c.id = call_signals.call_id
        AND (
          (c.caller_id = (SELECT auth.uid()) AND c.callee_id = call_signals.recipient_id)
          OR (c.callee_id = (SELECT auth.uid()) AND c.caller_id = call_signals.recipient_id)
        )
    )
  );

ALTER POLICY "Users can update their own participant row" ON public.conversation_participants
  USING (user_id = (SELECT auth.uid()))
  WITH CHECK (user_id = (SELECT auth.uid()));
ALTER POLICY "Members can view their conversations" ON public.conversations
  USING (
    EXISTS (
      SELECT 1 FROM public.conversation_participants AS cp
      WHERE cp.conversation_id = conversations.id
        AND cp.user_id = (SELECT auth.uid())
    )
  );

ALTER POLICY "Participants can add their own reaction" ON public.message_reactions
  WITH CHECK (
    user_id = (SELECT auth.uid())
    AND EXISTS (
      SELECT 1
      FROM public.messages AS m
      JOIN public.conversation_participants AS cp
        ON cp.conversation_id = m.conversation_id
      WHERE m.id = message_reactions.message_id
        AND cp.user_id = (SELECT auth.uid())
    )
  );
ALTER POLICY "Participants can read reactions in their conversations" ON public.message_reactions
  USING (
    EXISTS (
      SELECT 1
      FROM public.messages AS m
      JOIN public.conversation_participants AS cp
        ON cp.conversation_id = m.conversation_id
      WHERE m.id = message_reactions.message_id
        AND cp.user_id = (SELECT auth.uid())
    )
  );
ALTER POLICY "Users can change their own reaction" ON public.message_reactions
  USING (user_id = (SELECT auth.uid()))
  WITH CHECK (user_id = (SELECT auth.uid()));
ALTER POLICY "Users can remove their own reaction" ON public.message_reactions
  USING (user_id = (SELECT auth.uid()));

ALTER POLICY "Senders can edit or delete their own messages" ON public.messages
  USING (sender_id = (SELECT auth.uid()))
  WITH CHECK (sender_id = (SELECT auth.uid()));
ALTER POLICY "Users can update their own profile" ON public.profiles
  USING ((SELECT auth.uid()) = id);
ALTER POLICY "Users manage their own push tokens" ON public.push_tokens
  USING ((SELECT auth.uid()) = user_id)
  WITH CHECK ((SELECT auth.uid()) = user_id);
ALTER POLICY "Users can file reports" ON public.reports
  WITH CHECK ((SELECT auth.uid()) = reporter_id);
ALTER POLICY "Users can view their own reports" ON public.reports
  USING ((SELECT auth.uid()) = reporter_id);

COMMIT;
