const express = require('express');
const { supabaseAdmin } = require('../config/supabaseAdmin');
const { validPaystackWebhookSignature } = require('../utils/paystackWebhookSignature.cjs');

const router = express.Router();

async function verifyPaystackTransaction(reference) {
  const response = await fetch('https://api.paystack.co/transaction/verify/' + encodeURIComponent(reference), {
    headers: { Authorization: 'Bearer ' + process.env.PAYSTACK_SECRET_KEY },
    signal: AbortSignal.timeout(12000),
  });
  const payload = await response.json();
  if (!response.ok || payload?.status !== true || payload?.data?.status !== 'success') {
    throw new Error('Payment provider verification did not confirm success');
  }
  return payload.data;
}

router.post('/', express.raw({ type: 'application/json', limit: '100kb' }), async (req, res) => {
  const secret = process.env.PAYSTACK_SECRET_KEY;
  if (!secret) return res.status(503).json({ error: 'Payment webhook is not configured' });
  if (!validPaystackWebhookSignature({ rawBody: req.body, headers: req.headers, apiSecret: secret })) {
    return res.status(401).json({ error: 'Invalid payment webhook signature' });
  }

  let event;
  try { event = JSON.parse(req.body.toString('utf8')); } catch (_) {
    return res.status(400).json({ error: 'Invalid payment webhook payload' });
  }
  if (event?.event !== 'charge.success' || !event?.data?.reference) {
    return res.status(200).json({ received: true, ignored: true });
  }

  try {
    const eventReference = String(event.data.reference);
    const verified = await verifyPaystackTransaction(eventReference);
    if (String(verified.reference) !== eventReference) throw new Error('Verified payment reference mismatch');

    const { data: order, error: orderError } = await supabaseAdmin
      .from('live_spark_purchases')
      .select('id,user_id,amount_minor,currency,status,provider_fee_minor')
      .eq('provider_reference', eventReference)
      .maybeSingle();
    if (orderError) throw orderError;
    if (!order) return res.status(200).json({ received: true, ignored: true });
    if (String(verified.metadata?.purchase_id || '') !== order.id
        || Number(verified.amount) !== Number(order.amount_minor)
        || String(verified.currency).toUpperCase() !== order.currency) {
      throw new Error('Verified payment metadata, amount or currency does not match the purchase order');
    }
    const { data: account, error: accountError } = await supabaseAdmin.auth.admin.getUserById(order.user_id);
    if (accountError) throw accountError;
    const expectedEmail = String(account?.user?.email || '').trim().toLowerCase();
    const paidEmail = String(verified.customer?.email || '').trim().toLowerCase();
    if (!expectedEmail || !paidEmail || expectedEmail !== paidEmail) {
      throw new Error('Verified payment customer does not match the ZannyChat account');
    }
    const providerFeeMinor = Number(verified.fees);
    if (!Number.isSafeInteger(providerFeeMinor) || providerFeeMinor < 0
        || providerFeeMinor >= Number(order.amount_minor)) {
      throw new Error('Verified provider fee is missing or invalid');
    }
    if (order.status === 'pending') {
      const { data: feeOrder, error: feeError } = await supabaseAdmin
        .from('live_spark_purchases')
        .update({ provider_fee_minor: providerFeeMinor, updated_at: new Date().toISOString() })
        .eq('id', order.id).eq('status', 'pending').select('id').maybeSingle();
      if (feeError) throw feeError;
      if (!feeOrder) throw new Error('Could not persist verified provider fee before fulfilment');
    } else if (Number(order.provider_fee_minor) !== providerFeeMinor) {
      throw new Error('Verified provider fee differs from the already fulfilled purchase');
    }

    const { data, error } = await supabaseAdmin.rpc('fulfill_live_spark_purchase', {
      p_provider_reference: String(verified.reference),
      p_provider_transaction_id: String(verified.id),
      p_amount_minor: Number(verified.amount),
      p_currency: String(verified.currency),
    });
    if (error) {
      if (error.code === 'P0002') {
        console.warn('[live-purchases] verified payment has no matching ZannyChat order');
        return res.status(200).json({ received: true, ignored: true });
      }
      throw error;
    }
    return res.status(200).json({ received: true, fulfilled: !data?.rejected, rejected: Boolean(data?.rejected), replayed: Boolean(data?.replayed) });
  } catch (error) {
    console.error('[live-purchases] webhook fulfilment failed:', error?.message || error);
    return res.status(503).json({ error: 'Payment fulfilment will be retried' });
  }
});

module.exports = router;
