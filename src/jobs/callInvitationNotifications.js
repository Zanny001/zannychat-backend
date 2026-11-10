const { createCallEventToken } = require('../services/callEventToken');
const MAX_ATTEMPTS = 10;
const BASE_RETRY_MS = 15_000;
const MAX_RETRY_MS = 15 * 60_000;

function retryDelay(attempt) {
  return Math.min(MAX_RETRY_MS, BASE_RETRY_MS * (2 ** Math.max(0, Math.min(20, attempt))));
}

async function updateQueue(admin, callId, values) {
  const { error } = await admin.from('call_invitation_notifications').update(values).eq('call_id', callId);
  if (error) throw error;
}

async function runCallInvitationNotifications({ admin, sendPush, limit = 20, callId = null, now = () => new Date() } = {}) {
  if (!admin) admin = require('../config/supabaseAdmin').supabaseAdmin;
  if (!sendPush) sendPush = require('../config/pushClient').sendPushToUser;
  if (!admin) throw new Error('Supabase service client is not configured');
  const { data: jobs, error } = await admin.rpc('claim_call_invitation_notifications', { p_limit: limit, p_call_id: callId || null });
  if (error) throw error;
  const summary = { claimed: (jobs || []).length, sent: 0, expired: 0, retried: 0, failed: 0, noTokens: 0, partialFailures: 0 };

  for (const job of jobs || []) {
    try {
      const { data: call, error: callError } = await admin.from('call_sessions')
        .select('id,caller_id,callee_id,conversation_id,call_type,status,expires_at')
        .eq('id', job.call_id).maybeSingle();
      if (callError) throw callError;
      if (!call || call.status !== 'ringing' || new Date(call.expires_at).getTime() <= now().getTime()) {
        await updateQueue(admin, job.call_id, { status: 'expired', lease_started_at: null, last_error: null });
        summary.expired += 1;
        continue;
      }
      const { data: caller, error: callerError } = await admin.from('profiles').select('name').eq('id', call.caller_id).maybeSingle();
      if (callerError) throw callerError;
      const result = await sendPush(call.callee_id, {
        title: call.call_type === 'video' ? 'Incoming video call' : 'Incoming audio call',
        body: `${caller?.name || 'A ZannyChat contact'} is calling you`,
        data: { type: 'incoming_call', callId: call.id, conversationId: call.conversation_id, callType: call.call_type },
      });
      if (!result || result.noTokens || (result.sent < 1 && result.failed === 0)) {
        await updateQueue(admin, job.call_id, { status: 'expired', lease_started_at: null, last_error: 'No registered push tokens for callee' });
        summary.noTokens += 1;
        continue;
      }
      if (result.sent < 1) throw new Error('Expo rejected all call invitation pushes');
      // At least one device accepted the invite. Avoid duplicate pushes to
      // successful devices when another device has a partial provider error.
      await updateQueue(admin, job.call_id, { status: 'delivered', delivered_at: now().toISOString(), lease_started_at: null, last_error: null });
      summary.sent += result.sent;
      summary.partialFailures += Number(result.failed) || 0;
    } catch (error) {
      const attempts = (Number.isInteger(job.attempt_count) ? job.attempt_count : 0) + 1;
      const exhausted = attempts >= MAX_ATTEMPTS;
      const nextAt = new Date(now().getTime() + retryDelay(attempts));
      try {
        await updateQueue(admin, job.call_id, {
          status: exhausted ? 'expired' : 'pending', attempt_count: attempts,
          next_attempt_at: nextAt.toISOString(), lease_started_at: null,
          last_error: String(error?.message || 'Call push failed').replace(/[\r\n\t]/g, ' ').slice(0, 300),
        });
      } catch (_) {}
      if (exhausted) summary.failed += 1;
      else summary.retried += 1;
    }
  }
  return summary;
}

module.exports = { retryDelay, runCallInvitationNotifications };
