const express = require('express');
const { requireAuth } = require('../middleware/requireAuth');
const { supabaseAdmin } = require('../config/supabaseAdmin');

const router = express.Router();

// Everything in this file operates on the internal ledger created in
// supabase/migrations/0001_init.sql — there is no real payment
// processing wired up yet. It exists so the Wallet tab in the app has
// a real, working backend to build against once a payments provider
// (Stripe, Stellar, Circle — see webhooks.js) is connected.

router.get('/balance', requireAuth, async (req, res) => {
  if (!supabaseAdmin) return res.status(500).json({ error: 'Backend is not configured' });

  const { data, error } = await supabaseAdmin.rpc('get_wallet_balance', { p_user_id: req.user.id });
  if (error) return res.status(500).json({ error: error.message });

  res.json({ balance: data, currency: 'NGN' });
});

// Internal transfer between two ZannyChat wallets. Moves no real money
// — it's a double-entry pair of ledger rows, useful for testing the
// balance math and, later, for an in-app "split the bill" flow.
router.post('/transfer', requireAuth, async (req, res) => {
  if (!supabaseAdmin) return res.status(500).json({ error: 'Backend is not configured' });

  const { toUserId, amount, reason } = req.body || {};
  const numericAmount = Number(amount);

  if (!toUserId || !Number.isFinite(numericAmount) || numericAmount <= 0) {
    return res.status(400).json({ error: 'toUserId and a positive numeric amount are required' });
  }
  if (toUserId === req.user.id) {
    return res.status(400).json({ error: 'Cannot transfer to yourself' });
  }

  const { data: senderBalance, error: balanceError } = await supabaseAdmin.rpc('get_wallet_balance', {
    p_user_id: req.user.id,
  });
  if (balanceError) return res.status(500).json({ error: balanceError.message });
  if ((senderBalance ?? 0) < numericAmount) {
    return res.status(400).json({ error: 'Insufficient balance' });
  }

  const { error } = await supabaseAdmin.from('ledger_entries').insert([
    { wallet_id: req.user.id, amount: -numericAmount, reason: reason || 'transfer', reference: toUserId },
    { wallet_id: toUserId, amount: numericAmount, reason: reason || 'transfer', reference: req.user.id },
  ]);

  if (error) return res.status(500).json({ error: error.message });
  res.status(201).json({ status: 'ok' });
});

module.exports = router;
