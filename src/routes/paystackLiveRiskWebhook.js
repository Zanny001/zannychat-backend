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
    signal: AbortSignal.timeout(8000),
  });
  const payload = await response.json();
  if (!response.ok || payload?.status !== true) {
    throw new Error('Paystack risk resource verification failed');
  }
  return payload.data;
}

async function verifyRefundResource(eventData, secret, fetchImpl = fetch) {
  const transactionReference = String(eventData?.transaction_reference || '');
  const eventAmount = Number(eventData?.amount);
  const eventCurrency = String(eventData?.currency || '').toUpperCase();
  if (!transactionReference || !Number.isSafeInteger(eventAmount) || eventAmount <= 0 || !eventCurrency) {
    throw new Error('Refund webhook transaction details are missing');
  }

  // Paystack refund webhooks identify the original transaction with
  // transaction_reference; refund_reference may be null. Resolve the
  // transaction first, then fetch its refunds from the documented API.
  const transaction = await fetchPaystackData(
    'https://api.paystack.co/transaction/verify/' + encodeURIComponent(transactionReference),
    secret,
    fetchImpl,
  );
  if (!transaction?.id || String(transaction.reference || '') !== transactionReference
      || String(transaction.currency || '').toUpperCase() !== eventCurrency
      || (Number.isSafeInteger(Number(transaction.amount)) && eventAmount > Number(transaction.amount))) {
    throw new Error('Verified refund transaction does not match the webhook');
  }

  const refundReference = eventData?.refund_reference == null ? '' : String(eventData.refund_reference);
  let refunds;
  if (/^\\d+$/.test(refundReference)) {
    const refund = await fetchPaystackData(
      'https://api.paystack.co/refund/' + encodeURIComponent(refundReference),
      secret,
      fetchImpl,
    );
    refunds = refund ? [refund] : [];
  } else {
    const data = await fetchPaystackData(
      'https://api.paystack.co/refund?transaction=' + encodeURIComponent(String(transaction.id)) + '&perPage=100',
      secret,
      fetchImpl,
    );
    refunds = Array.isArray(data) ? data : (data ? [data] : []);
  }

  const candidates = refunds.filter((refund) =>
    String(refund.transaction) === String(transaction.id)
    && Number(refund.amount) === eventAmount
    && String(refund.currency || '').toUpperCase() === eventCurrency
  );
  let refund = null;
  if (refundReference) {
    refund = candidates.find((item) => String(item.id) === refundReference || String(item.reference || '') === refundReference) || null;
  } else if (candidates.length === 1) {
    refund = candidates[0];
  } else if (candidates.length > 1 && eventData.status) {
    const statusMatches = candidates.filter((item) => String(item.status).toLowerCase() === String(eventData.status).toLowerCase());
    if (statusMatches.length === 1) refund = statusMatches[0];
  }
  if (!refund || !REFUND_EVENT_BY_STATUS[String(refund.status).toLowerCase()]) {
    throw new Error('Verified refund record is missing or ambiguous');
  }

  return {
    eventType: REFUND_EVENT_BY_STATUS[String(refund.status).toLowerCase()],
    resourceId: 'refund:' + String(refund.id),
    providerReference: String(transaction.reference),
    providerStatus: String(refund.status).toLowerCase(),
    amountMinor: Number(refund.amount),
    currency: eventCurrency,
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
  const dueAt = dispute.dueAt ? new Date(dispute.dueAt) : null;
  if (dueAt && !Number.isFinite(dueAt.getTime())) throw new Error('Verified dispute due date is invalid');
  if (resolved && !['merchant-accepted', 'declined'].includes(String(dispute.resolution))) {
    throw new Error('Resolved dispute has an unsupported resolution');
  }
  if (!resolved && !['pending', 'awaiting-merchant-feedback', 'awaiting-bank-feedback'].includes(String(dispute.status).toLowerCase())) {
    throw new Error('Verified dispute status is not actionable');
  }
  return {
    eventType: resolved ? 'charge.dispute.resolve' : eventData.event,
    resourceId: 'dispute:' + disputeId,
    providerReference: String(dispute.transaction.reference),
    providerStatus: String(dispute.status),
    amountMinor: dispute.refund_amount == null ? null : Number(dispute.refund_amount),
    currency: String(dispute.currency || dispute.transaction.currency || '').toUpperCase(),
    resolution: dispute.resolution == null ? null : String(dispute.resolution),
    providerDueAt: dueAt ? dueAt.toISOString() : null,
  };
}

router.post('/', express.raw({ type: 'application/json', limit: '100kb' }), async (req, res, next) => {
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
  if (!isRefund && !isDispute) return next();

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
    if (verified.providerDueAt) {
      const { error: dueAtError } = await supabaseAdmin.from('live_purchase_risk_events')
        .update({ provider_due_at: verified.providerDueAt })
        .eq('event_key', eventKey);
      if (dueAtError) throw dueAtError;
    }
    return res.status(200).json({ received: true, ...data });
  } catch (error) {
    console.error('[live-purchase-risk] webhook processing failed:', error?.message || error);
    return res.status(503).json({ error: 'Purchase risk event will be retried' });
  }
});

module.exports = router;
module.exports.verifyRefundResource = verifyRefundResource;
module.exports.verifyDisputeResource = verifyDisputeResource;
