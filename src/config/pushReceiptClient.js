const { Expo } = require('expo-server-sdk');
const { supabaseAdmin } = require('./supabaseAdmin');
const { summarizePushReceipts } = require('./pushReceiptSummary');

const expo = new Expo();
const RECEIPT_DELAY_MS = 15 * 60 * 1000;
const MAX_TICKETS_PER_RUN = 1000;
const RETRY_DELAY_MS = 10 * 60 * 1000;

async function checkPendingPushReceipts({ now = Date.now(), limit = MAX_TICKETS_PER_RUN } = {}) {
  if (!supabaseAdmin) throw new Error('Push receipt storage is not configured');
  const before = new Date(now - RECEIPT_DELAY_MS).toISOString();
  const { data: rows, error } = await supabaseAdmin
    .from('push_receipt_tickets')
    .select('ticket_id, user_id, expo_push_token')
    .eq('receipt_status', 'pending')
    .lt('sent_at', before)
    .or(`last_attempted_at.is.null,last_attempted_at.lt.${new Date(now - RETRY_DELAY_MS).toISOString()}`)
    .order('sent_at', { ascending: true })
    .limit(Math.min(Math.max(Number(limit) || MAX_TICKETS_PER_RUN, 1), MAX_TICKETS_PER_RUN));
  if (error) throw error;

  const summary = { examined: (rows || []).length, checked: 0, delivered: 0, failed: 0, pending: 0, staleTokensRemoved: 0 };
  for (let offset = 0; offset < (rows || []).length; offset += 1000) {
    const batch = rows.slice(offset, offset + 1000);
    const ids = batch.map((row) => row.ticket_id);
    const { error: attemptError } = await supabaseAdmin
      .from('push_receipt_tickets')
      .update({ last_attempted_at: new Date(now).toISOString() })
      .in('ticket_id', ids)
      .eq('receipt_status', 'pending');
    if (attemptError) console.error('[push-receipts] attempt timestamp update failed:', attemptError.message);
    let receipts;
    try {
      receipts = await expo.getPushNotificationReceiptsAsync(ids);
    } catch (err) {
      // Keep these tickets pending; the next scheduled run can retry safely.
      console.error('[push-receipts] provider lookup failed:', err.message);
      summary.pending += batch.length;
      continue;
    }
    const result = summarizePushReceipts(receipts, batch);
    summary.checked += result.checked;
    summary.delivered += result.delivered;
    summary.failed += result.failed;
    summary.pending += result.pending;

    for (const update of result.updates) {
      const { error: updateError } = await supabaseAdmin
        .from('push_receipt_tickets')
        .update({ ...update, checked_at: new Date(now).toISOString() })
        .eq('ticket_id', update.ticket_id)
        .eq('receipt_status', 'pending');
      if (updateError) console.error('[push-receipts] ticket update failed:', updateError.message);
    }

    const staleTokens = [...new Set(result.staleTokens)];
    if (staleTokens.length) {
      const { error: cleanupError, count } = await supabaseAdmin
        .from('push_tokens')
        .delete({ count: 'exact' })
        .in('expo_push_token', staleTokens);
      if (cleanupError) console.error('[push-receipts] stale-token cleanup failed:', cleanupError.message);
      else summary.staleTokensRemoved += Number.isInteger(count) ? count : staleTokens.length;
    }
  }
  return summary;
}

module.exports = { checkPendingPushReceipts, RECEIPT_DELAY_MS, RETRY_DELAY_MS, MAX_TICKETS_PER_RUN };
