const { sendCallEndedToUser } = require('../config/callVoipPushClient');

const MAX_ATTEMPTS = 12;
const BASE_RETRY_MS = 15_000;
const MAX_RETRY_MS = 15 * 60_000;

function retryDelay(attempt) {
  return Math.min(MAX_RETRY_MS, BASE_RETRY_MS * (2 ** Math.max(0, Math.min(20, attempt))));
}

async function runCallEndNotifications({
  admin,
  sendCallEnded = sendCallEndedToUser,
  limit = 20,
  callId = null,
  now = () => new Date(),
} = {}) {
  if (!admin) admin = require('../config/supabaseAdmin').supabaseAdmin;
  if (!admin) throw new Error('Supabase service client is not configured');
  const { data: jobs, error } = await admin.rpc('claim_call_end_notifications', {
    p_limit: limit,
    p_call_id: callId || null,
  });
  if (error) throw error;

  const summary = { claimed: (jobs || []).length, delivered: 0, retried: 0, expired: 0, failed: 0 };
  for (const job of jobs || []) {
    try {
      const result = await sendCallEnded(admin, job.recipient_id, job.call_id, job.terminal_status);
      if (Number(result?.sent) > 0) {
        const { error: updateError } = await admin.from('call_end_notifications')
          .update({
            status: 'delivered',
            delivered_at: now().toISOString(),
            lease_started_at: null,
            last_error: Number(result.failed) > 0 ? 'Some registered devices rejected the terminal push' : null,
          })
          .eq('id', job.id);
        if (updateError) throw updateError;
        summary.delivered += 1;
        continue;
      }

      const attempts = (Number.isInteger(job.attempt_count) ? job.attempt_count : 0) + 1;
      const exhausted = attempts >= MAX_ATTEMPTS;
      const nextAt = new Date(now().getTime() + retryDelay(attempts));
      const { error: updateError } = await admin.from('call_end_notifications')
        .update({
          status: exhausted ? 'expired' : 'pending',
          attempt_count: attempts,
          next_attempt_at: nextAt.toISOString(),
          lease_started_at: null,
          last_error: result?.noTokens
            ? 'No registered Android FCM or iOS APNs alert token for recipient'
            : 'No call-ended push provider accepted the event',
        })
        .eq('id', job.id);
      if (updateError) throw updateError;
      if (exhausted) summary.expired += 1;
      else summary.retried += 1;
    } catch (error) {
      const attempts = (Number.isInteger(job.attempt_count) ? job.attempt_count : 0) + 1;
      const exhausted = attempts >= MAX_ATTEMPTS;
      const nextAt = new Date(now().getTime() + retryDelay(attempts));
      try {
        await admin.from('call_end_notifications')
          .update({
            status: exhausted ? 'expired' : 'pending',
            attempt_count: attempts,
            next_attempt_at: nextAt.toISOString(),
            lease_started_at: null,
            last_error: String(error?.message || 'Call-ended push failed').replace(/[\\r\\n\\t]/g, ' ').slice(0, 300),
          })
          .eq('id', job.id);
      } catch (_) {}
      if (exhausted) summary.failed += 1;
      else summary.retried += 1;
    }
  }
  return summary;
}

module.exports = { retryDelay, runCallEndNotifications };
