const express = require('express');
const { supabaseAdmin } = require('../config/supabaseAdmin');
const { validPaystackWebhookSignature } = require('../utils/paystackWebhookSignature.cjs');

const router = express.Router();

const REFUND_EVENT_BY_STATUS = {
  pending: 'refund.pending',
  processing: 'refund.processing',
  'needs-attention': 'refund.needs-attention',
  failed: 'refund.failed',
  processed: 'refund.processed',
};

async function fetchPaystackData(url, secret, fetchImpl = fetch) {
  const response = await fetchImpl(url, {
    headers: { Authorization: 'Bearer ' + secret },
    signal: AbortSignal.timeout(12000),
  });
  const payload = await response.json();
  if (!response.ok || payload?.status !== true) {
    throw new Error('Paystack risk resource verification failed');
  }
  return payload.data;
}

async function verifyRefundResource(eventData, secret, fetchImpl = fetch) {
  const refundReference = String(eventData?.reference || '');
  if (!refundReference) throw new Error('Refund reference is missing');
  const data = await fetchPaystackData(
    'https://api.paystack.co/refund?reference=' + encodeURIComponent(refundReference),
    secret,
    fetchImpl,
  );
  const refunds = Array.isArray(data) ? data : (data ? [data] : []);
  const refund = refunds.find((item) => String(item.reference || '') === refundReference) || refunds[0];
  if (!refund || !REFUND_EVENT_BY_STATUS[refund.status]) throw new Error('Verified refund record is missing or invalid');

  let transaction = refund.transaction;
  if (!transaction || typeof transaction !== 'object' || !transaction.reference) {
    const transactionId = typeof transaction === 'object' ? transaction.id : transaction;
    if (!transactionId) throw new Error('Refund is missing its original transaction');
    transaction = await fetchPaystackData(
      'https://api.paystack.co/transaction/' + encodeURIComponent(String(transactionId)),
      secret,
      fetchImpl,
    );
  }
  if (!transaction?.reference) throw new Error('Verified refund transaction reference is missing');

  const amount = Number(refund.amount);
  if (!Number.isSafeInteger(amount) || amount <= 0) throw new Error('Verified refund amount is invalid');
  return {
    eventType: REFUND_EVENT_BY_STATUS[refund.status],
    resourceId: String(refund.id || eventData.id || refundReference),
    providerReference: String(transaction.reference),
    providerStatus: String(refund.status),
    amountMinor: amount,
    currency: String(refund.currency || transaction.currency || '').toUpperCase(),
    resolution: null,
  };
}

async function verifyDisputeResource(eventData, secret, fetchImpl = fetch) {
  const disputeId = String(eventData?.id || '');
  if (!disputeId) throw new Error('Dispute identifier is missing');
  const dispute = await fetchPaystackData(
    'https://api.paystack.co/dispute/' + encodeURIComponent(disputeId),
    secret,
    fetchImpl,
  );
  if (!dispute || String(dispute.id) !== disputeId || !dispute.transaction?.reference) {
    throw new Error('Verified dispute record is missing or invalid');
  }
  const resolved = String(dispute.status).toLowerCase() === 'resolved';
  if (resolved && !['merchant-accepted', 'declined'].includes(String(dispute.resolution))) {
    throw new Error('Resolved dispute has an unsupported resolution');
  }
  if (!resolved && !['pending', 'awaiting-merchant-feedback', 'awaiting-bank-feedback'].includes(String(dispute.status).toLowerCase())) {
    throw new Error('Verified dispute status is not actionable');
  }
  return {
    eventType: resolved ? 'charge.dispute.resolve' : eventData.event,
    resourceId: disputeId,
    providerReference: String(dispute.transaction.reference),
    providerStatus: String(dispute.status),
    amountMinor: dispute.refund_amount == null ? null : Number(dispute.refund_amount),
    currency: String(dispute.currency || dispute.transaction.currency || '').toUpperCase(),
    resolution: dispute.resolution == null ? null : String(dispute.resolution),
  };
}

router.post('/', express.raw({ type: 'application/json', limit: '100kb' }), async (req, res) => {
  const secret = process.env.PAYSTACK_SECRET_KEY;
  if (!secret) return res.status(503).json({ error: 'Payment risk webhook is not configured' });
  if (!validPaystackWebhookSignature({ rawBody: req.body, headers: req.headers, apiSecret: secret })) {
    return res.status(401).json({ error: 'Invalid payment webhook signature' });
  }

  let event;
  try { event = JSON.parse(req.body.toString('utf8')); } catch (_) {
    return res.status(400).json({ error: 'Invalid payment webhook payload' });
  }
  const incomingType = String(event?.event || '');
  const isRefund = incomingType.startsWith('refund.');
  const isDispute = incomingType.startsWith('charge.dispute.');
  if (!isRefund && !isDispute) return res.status(200).json({ received: true, ignored: true });

  try {
    const verified = isRefund
      ? await verifyRefundResource(event.data, secret)
      : await verifyDisputeResource({ ...event.data, event: incomingType }, secret);

    if (!verified.providerReference || !verified.currency
        || (verified.amountMinor != null && (!Number.isSafeInteger(verified.amountMinor) || verified.amountMinor < 0))) {
      throw new Error('Verified risk resource has invalid transaction details');
    }
    const eventKey = 'paystack:' + verified.eventType + ':' + verified.resourceId;
    const { data, error } = await supabaseAdmin.rpc('record_live_purchase_risk_event', {
      p_event_key: eventKey,
      p_event_type: verified.eventType,
      p_provider_resource_id: verified.resourceId,
      p_provider_reference: verified.providerReference,
      p_provider_status: verified.providerStatus,
      p_amount_minor: verified.amountMinor,
      p_currency: verified.currency,
      p_resolution: verified.resolution,
    });
    if (error) throw error;
    return res.status(200).json({ received: true, ...data });
  } catch (error) {
    console.error('[live-purchase-risk] webhook processing failed:', error?.message || error);
    return res.status(503).json({ error: 'Purchase risk event will be retried' });
  }
});

module.exports = router;
module.exports.verifyRefundResource = verifyRefundResource;
module.exports.verifyDisputeResource = verifyDisputeResource;
