const express = require('express');
const crypto = require('node:crypto');
const { supabaseAdmin } = require('../config/supabaseAdmin');

const router = express.Router();

function validPaystackSignature(rawBody, signature, secret) {
  if (!Buffer.isBuffer(rawBody) || typeof signature !== 'string' || !secret) return false;
  const expected = crypto.createHmac('sha512', secret).update(rawBody).digest();
  let received;
  try { received = Buffer.from(signature, 'hex'); } catch (_) { return false; }
  return received.length === expected.length && crypto.timingSafeEqual(received, expected);
}

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
  if (!validPaystackSignature(req.body, req.headers['x-paystack-signature'], secret)) {
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
    const verified = await verifyPaystackTransaction(String(event.data.reference));
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
    return res.status(200).json({ received: true, fulfilled: true, replayed: Boolean(data?.replayed) });
  } catch (error) {
    console.error('[live-purchases] webhook fulfilment failed:', error?.message || error);
    return res.status(503).json({ error: 'Payment fulfilment will be retried' });
  }
});

module.exports = router;
