const express = require('express');
const { supabaseAdmin } = require('../config/supabaseAdmin');

const router = express.Router();

// Stripe needs the RAW request body to verify a webhook's signature, so
// this route is mounted in index.js BEFORE the global express.json()
// parser, and uses express.raw() itself instead.
router.post('/stripe', express.raw({ type: 'application/json' }), async (req, res) => {
  const signature = req.headers['stripe-signature'];
  const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET;

  if (!webhookSecret || !process.env.STRIPE_SECRET_KEY) {
    console.warn('[webhooks/stripe] Stripe env vars are not set — rejecting webhook.');
    return res.status(501).json({ error: 'Stripe is not configured on this backend yet' });
  }

  let event;
  try {
    // Required only once Stripe keys exist — see .env.example.
    // eslint-disable-next-line global-require
    const Stripe = require('stripe');
    const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);
    event = stripe.webhooks.constructEvent(req.body, signature, webhookSecret);
  } catch (err) {
    return res.status(400).json({ error: `Webhook signature verification failed: ${err.message}` });
  }

  console.log('[webhooks/stripe] received event:', event.type);

  // TODO (Phase 2): on a successful payment event, credit the buyer's
  // wallet, e.g.:
  //
  //   if (event.type === 'checkout.session.completed') {
  //     const session = event.data.object;
  //     await supabaseAdmin.from('ledger_entries').insert({
  //       wallet_id: session.client_reference_id, // set this when creating the session
  //       amount: session.amount_total / 100,
  //       reason: 'stripe_topup',
  //       reference: session.id,
  //     });
  //   }

  res.json({ received: true });
});

module.exports = router;
