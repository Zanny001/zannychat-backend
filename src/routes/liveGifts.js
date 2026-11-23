const express = require('express');
const { requireAuth } = require('../middleware/requireAuth');
const { makeLimiter } = require('../middleware/rateLimit');
const { supabaseAdmin } = require('../config/supabaseAdmin');

const router = express.Router();
router.use(requireAuth, makeLimiter({ windowMs: 60 * 1000, max: 60, error: 'LIVE gift actions are rate-limited.' }));

function validUuid(value) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(String(value || ''));
}

router.get('/catalog', async (req, res) => {
  try {
    const { data, error } = await supabaseAdmin.from('live_gift_catalog')
      .select('gift_id,display_name,emoji,spark_cost,score_points,sort_order')
      .eq('is_active', true).order('sort_order', { ascending: true });
    if (error) throw error;
    return res.json({ gifts: data || [], currency: 'Sparks', cashValue: false });
  } catch (error) {
    console.error('[live-gifts] catalog failed:', error?.message || error);
    return res.status(503).json({ error: 'LIVE gifts are temporarily unavailable' });
  }
});

router.get('/wallet', async (req, res) => {
  try {
    const { data, error } = await supabaseAdmin.from('live_gift_wallets')
      .select('balance_sparks,updated_at').eq('user_id', req.user.id).maybeSingle();
    if (error) throw error;
    return res.json({ balanceSparks: data?.balance_sparks || 0, updatedAt: data?.updated_at || null,
      currency: 'Sparks', cashValue: false, purchasable: false, redeemable: false });
  } catch (error) {
    console.error('[live-gifts] wallet lookup failed:', error?.message || error);
    return res.status(503).json({ error: 'LIVE gift balance is temporarily unavailable' });
  }
});

router.get('/history', async (req, res) => {
  try {
    const limit = Math.min(50, Math.max(1, Number.parseInt(req.query.limit, 10) || 20));
    const { data, error } = await supabaseAdmin.from('live_gift_ledger')
      .select('id,entry_type,amount_sparks,balance_after,reference_type,reference_id,note,created_at')
      .eq('user_id', req.user.id).order('created_at', { ascending: false }).limit(limit);
    if (error) throw error;
    return res.json({ entries: data || [] });
  } catch (error) {
    console.error('[live-gifts] ledger lookup failed:', error?.message || error);
    return res.status(503).json({ error: 'LIVE gift history is temporarily unavailable' });
  }
});

router.post('/send', makeLimiter({ windowMs: 60 * 1000, max: 12, error: 'Please wait before sending another LIVE gift.' }), async (req, res) => {
  const { streamId, recipientId, giftId, quantity = 1, idempotencyKey, battleId = null } = req.body || {};
  if (!validUuid(streamId) || !validUuid(recipientId) || !/^[a-z][a-z0-9_]{1,39}$/.test(String(giftId || ''))
      || !Number.isInteger(quantity) || quantity < 1 || quantity > 20
      || typeof idempotencyKey !== 'string' || idempotencyKey.length < 8 || idempotencyKey.length > 128
      || (battleId !== null && !validUuid(battleId))) {
    return res.status(400).json({ error: 'Invalid LIVE gift request' });
  }
  try {
    const { data, error } = await supabaseAdmin.rpc('send_live_gift', {
      p_sender_id: req.user.id,
      p_stream_id: streamId,
      p_recipient_id: recipientId,
      p_gift_id: giftId,
      p_quantity: quantity,
      p_idempotency_key: idempotencyKey,
      p_battle_id: battleId,
    });
    if (error) {
      if (error.code === '42501') return res.status(403).json({ error: 'Join this LIVE before sending a gift' });
      if (error.code === '22023') return res.status(400).json({ error: error.message || 'Invalid LIVE gift request' });
      if (error.code === 'P0001' && /insufficient LIVE Sparks/i.test(error.message || '')) {
        return res.status(409).json({ error: 'Not enough LIVE Sparks', code: 'INSUFFICIENT_SPARKS' });
      }
      if (error.code === 'P0001') return res.status(409).json({ error: error.message || 'LIVE gift cannot be sent' });
      if (error.code === '23505') return res.status(409).json({ error: 'This gift request conflicts with an earlier request' });
      throw error;
    }
    return res.status(data?.replayed ? 200 : 201).json(data);
  } catch (error) {
    console.error('[live-gifts] send failed:', error?.message || error);
    return res.status(503).json({ error: 'Could not send this LIVE gift' });
  }
});

module.exports = router;
