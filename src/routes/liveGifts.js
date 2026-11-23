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
    const [{ data, error }, { data: lots, error: lotsError }] = await Promise.all([
      supabaseAdmin.from('live_gift_wallets')
        .select('balance_sparks,updated_at').eq('user_id', req.user.id).maybeSingle(),
      supabaseAdmin.from('live_spark_lots')
        .select('source,remaining_sparks').eq('user_id', req.user.id).gt('remaining_sparks', 0),
    ]);
    if (error) throw error;
    if (lotsError) throw lotsError;
    const sourceBalances = (lots || []).reduce((totals, lot) => {
      const amount = Number(lot.remaining_sparks || 0);
      if (lot.source === 'purchase') totals.purchasedSparks += amount;
      else if (lot.source === 'promotion') totals.promotionalSparks += amount;
      else totals.legacySparks += amount;
      return totals;
    }, { purchasedSparks: 0, promotionalSparks: 0, legacySparks: 0 });
    return res.json({
      balanceSparks: Number(data?.balance_sparks || 0),
      ...sourceBalances,
      updatedAt: data?.updated_at || null,
      currency: 'Sparks',
      cashValue: false,
      purchasable: false,
      redeemable: false,
    });
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


router.get('/stream/:streamId/recent', async (req, res) => {
  const streamId = req.params.streamId;
  if (!validUuid(streamId)) return res.status(400).json({ error: 'Invalid LIVE stream id' });
  try {
    const { data: stream, error: streamError } = await supabaseAdmin.from('live_streams')
      .select('id,creator_id,status').eq('id', streamId).maybeSingle();
    if (streamError) throw streamError;
    if (!stream || stream.status !== 'live') return res.status(404).json({ error: 'LIVE stream has ended' });

    let isJoined = stream.creator_id === req.user.id;
    if (!isJoined) {
      const { data: participant, error: participantError } = await supabaseAdmin.from('live_stream_participants')
        .select('user_id').eq('stream_id', streamId).eq('user_id', req.user.id)
        .eq('status', 'joined').is('left_at', null).maybeSingle();
      if (participantError) throw participantError;
      isJoined = Boolean(participant);
    }
    if (!isJoined) return res.status(403).json({ error: 'Join this LIVE to view its gift activity' });

    const { data: transactions, error: transactionsError } = await supabaseAdmin.from('live_gift_transactions')
      .select('id,sender_id,recipient_id,gift_id,quantity,score_points,battle_id,created_at')
      .eq('stream_id', streamId).order('created_at', { ascending: false }).limit(20);
    if (transactionsError) throw transactionsError;

    const userIds = [...new Set((transactions || []).flatMap((item) => [item.sender_id, item.recipient_id]).filter(Boolean))];
    const giftIds = [...new Set((transactions || []).map((item) => item.gift_id).filter(Boolean))];
    const [{ data: profiles, error: profilesError }, { data: gifts, error: giftsError }] = await Promise.all([
      userIds.length
        ? supabaseAdmin.from('profiles').select('id,name,avatar_color').in('id', userIds)
        : Promise.resolve({ data: [], error: null }),
      giftIds.length
        ? supabaseAdmin.from('live_gift_catalog').select('gift_id,display_name,emoji').in('gift_id', giftIds)
        : Promise.resolve({ data: [], error: null }),
    ]);
    if (profilesError) throw profilesError;
    if (giftsError) throw giftsError;

    const profilesById = new Map((profiles || []).map((item) => [item.id, item]));
    const giftsById = new Map((gifts || []).map((item) => [item.gift_id, item]));
    const events = (transactions || []).map((item) => {
      const sender = profilesById.get(item.sender_id);
      const recipient = profilesById.get(item.recipient_id);
      const gift = giftsById.get(item.gift_id);
      return {
        id: item.id,
        senderName: sender?.name || 'ZannyChat member',
        senderAvatarColor: sender?.avatar_color || null,
        recipientName: recipient?.name || 'LIVE participant',
        recipientAvatarColor: recipient?.avatar_color || null,
        giftName: gift?.display_name || item.gift_id,
        emoji: gift?.emoji || '🎁',
        quantity: item.quantity,
        scorePoints: Number(item.score_points || 0),
        battleId: item.battle_id || null,
        createdAt: item.created_at,
      };
    });
    return res.json({ events });
  } catch (error) {
    console.error('[live-gifts] stage activity lookup failed:', error?.message || error);
    return res.status(503).json({ error: 'LIVE gift activity is temporarily unavailable' });
  }
});

router.post('/send', makeLimiter({ windowMs: 60 * 1000, max: 12, error: 'Please wait before sending another LIVE gift.' }), async (req, res) => {
  const { streamId, recipientId, giftId, quantity = 1, idempotencyKey } = req.body || {};
  if (!validUuid(streamId) || !validUuid(recipientId) || !/^[a-z][a-z0-9_]{1,39}$/.test(String(giftId || ''))
      || !Number.isInteger(quantity) || quantity < 1 || quantity > 20
      || typeof idempotencyKey !== 'string' || idempotencyKey.length < 8 || idempotencyKey.length > 128) {
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
