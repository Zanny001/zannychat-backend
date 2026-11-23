const express = require('express');
const { requireAuth } = require('../middleware/requireAuth');
const { makeLimiter } = require('../middleware/rateLimit');
const { supabaseAdmin } = require('../config/supabaseAdmin');
const { sendPushToUser } = require('../config/pushClient');

const router = express.Router();
router.use(requireAuth, makeLimiter({ windowMs: 60 * 1000, max: 30, error: 'LIVE battle actions are rate-limited.' }));

function validUuid(value) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(String(value || ''));
}

function respondRpcError(res, error) {
  if (error?.code === '42501') return res.status(403).json({ error: error.message || 'You cannot perform this PK battle action' });
  if (error?.code === '22023') return res.status(400).json({ error: error.message || 'Invalid PK battle request' });
  if (error?.code === '23505') return res.status(409).json({ error: 'A PK battle is already open for this LIVE' });
  if (error?.code === 'P0001') return res.status(409).json({ error: error.message || 'PK battle state has changed' });
  return null;
}

router.post('/', async (req, res) => {
  const { streamId, opponentId, durationSeconds = 300 } = req.body || {};
  if (!validUuid(streamId) || !validUuid(opponentId)
      || !Number.isInteger(durationSeconds) || durationSeconds < 60 || durationSeconds > 900) {
    return res.status(400).json({ error: 'Provide a valid LIVE stream, stage guest, and 60–900 second duration' });
  }
  try {
    const { data, error } = await supabaseAdmin.rpc('create_live_pk_battle', {
      p_stream_id: streamId,
      p_creator_a_id: req.user.id,
      p_creator_b_id: opponentId,
      p_duration_seconds: durationSeconds,
    });
    if (error) return respondRpcError(res, error) || res.status(503).json({ error: 'Could not create PK battle' });
    void sendPushToUser(opponentId, { title: 'LIVE PK challenge', body: 'A creator challenged you. Open this LIVE to accept or decline.', data: { type: 'live_pk_challenge', streamId, battleId: data } })
      .catch((pushError) => console.error('[live-battles] challenge notification failed:', pushError?.message || pushError));
    return res.status(201).json({ battleId: data, status: 'pending', scoring: 'gift_points_only' });
  } catch (error) {
    console.error('[live-battles] create failed:', error?.message || error);
    return res.status(503).json({ error: 'Could not create PK battle' });
  }
});


router.post('/:battleId/accept', async (req, res) => {
  if (!validUuid(req.params.battleId)) return res.status(400).json({ error: 'Invalid PK battle id' });
  try {
    const { data, error } = await supabaseAdmin.rpc('accept_live_pk_battle', {
      p_battle_id: req.params.battleId,
      p_creator_id: req.user.id,
    });
    if (error) return respondRpcError(res, error) || res.status(503).json({ error: 'Could not accept PK challenge' });
    if (data?.status === 'accepted') {
      void sendPushToUser(data.creator_a_id, { title: 'PK challenge accepted', body: 'Your LIVE PK challenge was accepted. You can start the battle.', data: { type: 'live_pk_accepted', battleId: data.id, streamId: data.stream_id } })
        .catch((pushError) => console.error('[live-battles] acceptance notification failed:', pushError?.message || pushError));
    }
    return res.json({ battle: data });
  } catch (error) {
    console.error('[live-battles] accept failed:', error?.message || error);
    return res.status(503).json({ error: 'Could not accept PK challenge' });
  }
});

router.post('/:battleId/decline', async (req, res) => {
  if (!validUuid(req.params.battleId)) return res.status(400).json({ error: 'Invalid PK battle id' });
  try {
    const { data, error } = await supabaseAdmin.rpc('decline_live_pk_battle', {
      p_battle_id: req.params.battleId,
      p_creator_id: req.user.id,
    });
    if (error) return respondRpcError(res, error) || res.status(503).json({ error: 'Could not decline PK challenge' });
    void sendPushToUser(data.creator_a_id, { title: 'PK challenge declined', body: 'Your LIVE PK challenge was declined.', data: { type: 'live_pk_declined', battleId: data.id, streamId: data.stream_id } })
      .catch((pushError) => console.error('[live-battles] decline notification failed:', pushError?.message || pushError));
    return res.json({ battle: data });
  } catch (error) {
    console.error('[live-battles] decline failed:', error?.message || error);
    return res.status(503).json({ error: 'Could not decline PK challenge' });
  }
});

router.post('/:battleId/start', async (req, res) => {
  if (!validUuid(req.params.battleId)) return res.status(400).json({ error: 'Invalid PK battle id' });
  try {
    const { data, error } = await supabaseAdmin.rpc('start_live_pk_battle', {
      p_battle_id: req.params.battleId,
      p_creator_id: req.user.id,
    });
    if (error) return respondRpcError(res, error) || res.status(503).json({ error: 'Could not start PK battle' });
    return res.json({ battle: data });
  } catch (error) {
    console.error('[live-battles] start failed:', error?.message || error);
    return res.status(503).json({ error: 'Could not start PK battle' });
  }
});

router.post('/:battleId/finish', async (req, res) => {
  if (!validUuid(req.params.battleId)) return res.status(400).json({ error: 'Invalid PK battle id' });
  try {
    const { data, error } = await supabaseAdmin.rpc('finish_live_pk_battle', {
      p_battle_id: req.params.battleId,
      p_creator_id: req.user.id,
    });
    if (error) return respondRpcError(res, error) || res.status(503).json({ error: 'Could not finish PK battle' });
    return res.json({ battle: data });
  } catch (error) {
    console.error('[live-battles] finish failed:', error?.message || error);
    return res.status(503).json({ error: 'Could not finish PK battle' });
  }
});


router.get('/stream/:streamId/current', async (req, res) => {
  const streamId = req.params.streamId;
  if (!validUuid(streamId)) return res.status(400).json({ error: 'Invalid LIVE stream id' });
  try {
    const { data: participant, error: participantError } = await supabaseAdmin.from('live_stream_participants')
      .select('user_id,role').eq('stream_id', streamId).eq('user_id', req.user.id)
      .eq('status', 'joined').is('left_at', null).maybeSingle();
    if (participantError) throw participantError;
    if (!participant) return res.status(403).json({ error: 'Join this LIVE to view its PK battle' });
    const { error: expiryError } = await supabaseAdmin.rpc('expire_live_pk_battle_challenges', { p_stream_id: streamId });
    if (expiryError) throw expiryError;
    const { data: battle, error } = await supabaseAdmin.from('live_pk_battles')
      .select('id,stream_id,creator_a_id,creator_b_id,status,score_a,score_b,duration_seconds,started_at,ends_at,winner_id,created_at')
      .eq('stream_id', streamId).in('status', ['pending', 'accepted', 'live', 'ended', 'cancelled'])
      .order('created_at', { ascending: false }).limit(1).maybeSingle();
    if (error) throw error;
    if (!battle) return res.json({ battle: null, scoring: 'gift_points_only' });
    let settled = battle;
    if (battle.status === 'live' && battle.ends_at && Date.now() >= Date.parse(battle.ends_at)) {
      const result = await supabaseAdmin.rpc('finish_live_pk_battle', {
        p_battle_id: battle.id, p_creator_id: null,
      });
      if (result.error && result.error.code !== 'P0001') throw result.error;
      const refreshed = await supabaseAdmin.from('live_pk_battles')
        .select('id,stream_id,creator_a_id,creator_b_id,status,score_a,score_b,duration_seconds,started_at,ends_at,winner_id,created_at')
        .eq('id', battle.id).maybeSingle();
      if (refreshed.error) throw refreshed.error;
      if (refreshed.data) settled = refreshed.data;
    }
    return res.json({ battle: { ...settled, canAccept: participant?.role === 'guest' && req.user.id === settled.creator_b_id && settled.status === 'pending', canStart: participant?.role === 'creator' && req.user.id === settled.creator_a_id && settled.status === 'accepted' }, scoring: 'gift_points_only' });
  } catch (error) {
    console.error('[live-battles] current battle lookup failed:', error?.message || error);
    return res.status(503).json({ error: 'Could not load the current PK battle' });
  }
});

router.get('/:battleId', async (req, res) => {
  if (!validUuid(req.params.battleId)) return res.status(400).json({ error: 'Invalid PK battle id' });
  try {
    const { data: battle, error } = await supabaseAdmin.from('live_pk_battles')
      .select('id,stream_id,creator_a_id,creator_b_id,status,score_a,score_b,duration_seconds,started_at,ends_at,winner_id,created_at')
      .eq('id', req.params.battleId).maybeSingle();
    if (error) throw error;
    if (!battle) return res.status(404).json({ error: 'PK battle not found' });
    const { data: participant, error: participantError } = await supabaseAdmin.from('live_stream_participants')
      .select('user_id,role').eq('stream_id', battle.stream_id).eq('user_id', req.user.id)
      .eq('status', 'joined').is('left_at', null).maybeSingle();
    if (participantError) throw participantError;
    if (!participant && ![battle.creator_a_id, battle.creator_b_id].includes(req.user.id)) {
      return res.status(403).json({ error: 'Join this LIVE to view its PK battle' });
    }
    let settled = battle;
    if (battle.status === 'live' && battle.ends_at && Date.now() >= Date.parse(battle.ends_at)) {
      const result = await supabaseAdmin.rpc('finish_live_pk_battle', {
        p_battle_id: battle.id, p_creator_id: null,
      });
      if (result.error && result.error.code !== 'P0001') throw result.error;
      const refreshed = await supabaseAdmin.from('live_pk_battles')
        .select('id,stream_id,creator_a_id,creator_b_id,status,score_a,score_b,duration_seconds,started_at,ends_at,winner_id,created_at')
        .eq('id', battle.id).maybeSingle();
      if (refreshed.error) throw refreshed.error;
      if (refreshed.data) settled = refreshed.data;
    }
    return res.json({ battle: { ...settled, canAccept: participant?.role === 'guest' && req.user.id === settled.creator_b_id && settled.status === 'pending', canStart: participant?.role === 'creator' && req.user.id === settled.creator_a_id && settled.status === 'accepted' }, scoring: 'gift_points_only' });
  } catch (error) {
    console.error('[live-battles] read failed:', error?.message || error);
    return res.status(503).json({ error: 'Could not load PK battle' });
  }
});

module.exports = router;
