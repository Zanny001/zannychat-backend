const express = require('express');
const { supabaseAdmin } = require('../config/supabaseAdmin');
const { validPaystackWebhookSignature } = require('../utils/paystackWebhookSignature.cjs');

const router = express.Router();

async function verifyTransfer(reference) {
  const response = await fetch('https://api.paystack.co/transfer/verify/' + encodeURIComponent(reference), {
    headers: { Authorization: 'Bearer ' + process.env.PAYSTACK_SECRET_KEY },
    signal: AbortSignal.timeout(12000),
  });
  const payload = await response.json();
  if (!response.ok || payload?.status !== true || !payload?.data?.status) {
    throw new Error('Paystack transfer verification did not return a final status');
  }
  return payload.data;
}

router.post('/', express.raw({ type: 'application/json', limit: '100kb' }), async (req, res, next) => {
  const secret = process.env.PAYSTACK_SECRET_KEY;
  if (!secret) return res.status(503).json({ error: 'Payout webhook is not configured' });
  if (!validPaystackWebhookSignature({ rawBody: req.body, headers: req.headers, apiSecret: secret })) {
    return res.status(401).json({ error: 'Invalid payout webhook signature' });
  }

  let event;
  try { event = JSON.parse(req.body.toString('utf8')); } catch (_) {
    return res.status(400).json({ error: 'Invalid payout webhook payload' });
  }
  if (!['transfer.success', 'transfer.failed', 'transfer.reversed'].includes(event?.event)
      || !event?.data?.reference) return next();

  try {
    const reference = String(event.data.reference);
    const transfer = await verifyTransfer(reference);
    if (String(transfer.reference) !== reference) throw new Error('Verified transfer reference mismatch');

    const statusMap = { success: 'paid', failed: 'failed', reversed: 'reversed', pending: 'processing', otp: 'processing' };
    const status = statusMap[String(transfer.status).toLowerCase()];
    if (!status) return res.status(200).json({ received: true, ignored: true });

    const update = {
      status,
      provider_transfer_code: transfer.transfer_code || null,
      updated_at: new Date().toISOString(),
      ...(status === 'paid' || status === 'failed' || status === 'reversed'
        ? { completed_at: new Date().toISOString() } : {}),
      ...(status === 'failed' || status === 'reversed'
        ? { failure_code: String(transfer.failure_code || status), failure_message: 'Transfer ' + status } : {}),
    };
    const { data, error } = await supabaseAdmin.from('live_creator_payouts')
      .update(update).eq('provider_reference', reference)
      .in('status', ['requested', 'processing'])
      .select('id,status').maybeSingle();
    if (error) throw error;
    if (!data) return res.status(200).json({ received: true, ignored: true });
    return res.status(200).json({ received: true, reconciled: true, status: data.status });
  } catch (error) {
    console.error('[live-payouts] transfer webhook reconciliation failed:', error?.message || error);
    return res.status(503).json({ error: 'Payout reconciliation will be retried' });
  }
});

module.exports = router;
