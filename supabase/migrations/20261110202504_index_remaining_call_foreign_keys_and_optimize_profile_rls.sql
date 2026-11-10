-- Cover the remaining foreign keys identified by the Supabase performance advisor.
CREATE INDEX IF NOT EXISTS call_invitation_notifications_callee_id_idx
  ON public.call_invitation_notifications (callee_id);
CREATE INDEX IF NOT EXISTS call_invitation_notifications_caller_id_idx
  ON public.call_invitation_notifications (caller_id);
CREATE INDEX IF NOT EXISTS group_call_rooms_host_user_id_idx
  ON public.group_call_rooms (host_user_id);

-- Preserve owner-only semantics while evaluating auth.uid() once per statement.
ALTER POLICY "Owners manage their private profile details"
  ON public.profile_details
  USING (user_id = (SELECT auth.uid()))
  WITH CHECK (user_id = (SELECT auth.uid()));
