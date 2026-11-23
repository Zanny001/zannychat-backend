const DEFAULT_RECONCILIATION_AGE_MS = 5 * 60 * 1000;
const MAX_RECONCILIATION_BATCH = 100;
const TRANSFER_STATUS_MAP = Object.freeze({
  success: 'paid',
  failed: 'failed',
  reversed: 'reversed',
  pending: 'processing',
  otp: 'processing',
});

function mapPaystackTransferStatus(value) {
  return TRANSFER_STATUS_MAP[String(value || '').toLowerCase()] || null;
}

async function reconcilePendingCreatorPayouts({
  supabase,
  fetchImpl = fetch,
  secret = process.env.PAYSTACK_SECRET_KEY,
  now = new Date(),
  minimumAgeMs = DEFAULT_RECONCILIATION_AGE_MS,
  limit = MAX_RECONCILIATION_BATCH,
  logger = console,
} = {}) {
  if (!supabase) return { skipped: true, reason: 'supabase_not_configured' };
  if (!secret) return { skipped: true, reason: 'paystack_not_configured' };

  const cutoff = new Date(now.getTime() - minimumAgeMs).toISOString();
  const { data: payouts, error: queryError } = await supabase
    .from('live_creator_payouts')
    .select('id,provider_reference,amount_minor,currency,status,requested_at')
    .in('status', ['requested', 'processing'])
    .lt('requested_at', cutoff)
    .order('requested_at', { ascending: true })
    .limit(Math.min(MAX_RECONCILIATION_BATCH, Math.max(1, limit)));
  if (queryError) throw queryError;

  const summary = { skipped: false, scanned: Array.isArray(payouts) ? payouts.length : 0, reconciled: 0, pending: 0, errors: 0 };
  for (const payout of Array.isArray(payouts) ? payouts : []) {
    try {
      const response = await fetchImpl(
        'https://api.paystack.co/transfer/verify/' + encodeURIComponent(String(payout.provider_reference)),
        {
          headers: { Authorization: 'Bearer ' + secret },
          signal: AbortSignal.timeout(12000),
        },
      );
      const payload = await response.json();
      if (!response.ok || payload?.status !== true || !payload?.data) {
        throw new Error('Paystack transfer verification was unavailable');
      }

      const transfer = payload.data;
      const reference = String(transfer.reference || '');
      if (reference !== String(payout.provider_reference)
          || Number(transfer.amount) !== Number(payout.amount_minor)
          || String(transfer.currency || '').toUpperCase() !== String(payout.currency || '').toUpperCase()) {
        throw new Error('Verified Paystack transfer does not match the reserved payout');
      }

      const status = mapPaystackTransferStatus(transfer.status);
      if (!status) {
        summary.pending += 1;
        continue;
      }

      const isFinal = ['paid', 'failed', 'reversed'].includes(status);
      const timestamp = now.toISOString();
      const update = {
        status,
        provider_transfer_code: transfer.transfer_code || null,
        updated_at: timestamp,
        ...(isFinal ? { completed_at: timestamp } : {}),
        ...(status === 'failed' || status === 'reversed'
          ? {
              failure_code: String(transfer.failure_code || status),
              failure_message: 'Transfer ' + status,
            }
          : {}),
      };
      const { data, error } = await supabase
        .from('live_creator_payouts')
        .update(update)
        .eq('provider_reference', String(payout.provider_reference))
        .in('status', ['requested', 'processing'])
        .select('id,status')
        .maybeSingle();
      if (error) throw error;
      if (data) summary.reconciled += 1;
      else summary.pending += 1;
    } catch (error) {
      summary.errors += 1;
      logger.warn?.('[reconciliation] payout verification deferred:', error?.message || 'provider error');
    }
  }

  logger.info?.('[reconciliation] payout reconciliation complete', summary);
  return summary;
}

module.exports = {
  reconcilePendingCreatorPayouts,
  mapPaystackTransferStatus,
  DEFAULT_RECONCILIATION_AGE_MS,
  MAX_RECONCILIATION_BATCH,
};
