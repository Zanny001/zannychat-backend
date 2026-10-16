const express = require('express');
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
    console.warn('[webhooks] signature verification failed');
    return res.status(400).json({ error: 'Webhook signature verification failed' });
  }

  console.log('[webhooks/stripe] received event:', event.type);

  // This endpoint only acknowledges verified events. It intentionally
  // does not process payments or mutate application balances.

  res.json({ received: true });
});

module.exports = router;
