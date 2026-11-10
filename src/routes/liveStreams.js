const express = require('express');
const { randomUUID } = require('node:crypto');
const { requireAuth } = require('../middleware/requireAuth');
const { makeLimiter } = require('../middleware/rateLimit');
const { supabaseAdmin } = require('../config/supabaseAdmin');
const { createLiveKitToken, getLiveKitConfig } = require('../services/livekitToken');

const router = express.Router();
router.use(requireAuth, makeLimiter({ windowMs: 60 * 1000, max: 30, error: 'LIVE actions are rate-limited.' }));

const REASONS = new Set(['harassment','hate','nudity','violence','spam','copyright','other']);
const REACTIONS = new Set(['heart','clap','laugh','wow','fire']);

function validId(value) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(String(value || ''));
}

function issueToken(user, roomName, config, canPublish) {
  return createLiveKitToken({
    identity: user.id,
    name: user.user_metadata?.name || user.user_metadata?.full_name || 'ZannyChat viewer',
    room: roomName,
    canPublish,
    canSubscribe: true,
    canPublishData: true,
    config,
  });
}

async function hasBlockBetween(userA, userB) {
  const { data: first, error: firstError } = await supabaseAdmin.from('blocked_users')
    .select('blocker_id').eq('blocker_id', userA).eq('blocked_id', userB).maybeSingle();
  if (firstError) throw firstError;
  const { data: second, error: secondError } = await supabaseAdmin.from('blocked_users')
    .select('blocker_id').eq('blocker_id', userB).eq('blocked_id', userA).maybeSingle();
  if (secondError) throw secondError;
  return Boolean(first || second);
}

async function getStream(streamId) {
  const { data, error } = await supabaseAdmin.from('live_streams')
    .select('id,creator_id,title,description,room_name,visibility,status,allow_comments,allow_guests,viewer_limit,started_at')
    .eq('id', streamId).maybeSingle();
  if (error) throw error;
  return data;
}

async function requireJoined(streamId, userId) {
  const { data, error } = await supabaseAdmin.from('live_stream_participants')
    .select('id,role,status').eq('stream_id', streamId).eq('user_id', userId).maybeSingle();
  if (error) throw error;
  return data?.status === 'joined' ? data : null;
}

router.get('/', async (_req, res) => {
  try {
    const { data, error } = await supabaseAdmin.from('live_streams')
      .select('id,creator_id,title,description,started_at,viewer_limit')
      .eq('status', 'live').eq('visibility', 'public')
      .order('started_at', { ascending: false }).limit(50);
    if (error) throw error;
    return res.json({ streams: data || [] });
  } catch (error) {
    console.error('[live] discover failed:', error?.message || error);
    return res.status(503).json({ error: 'LIVE discovery is temporarily unavailable' });
  }
});

router.post('/', async (req, res) => {
  const title = typeof req.body?.title === 'string' ? req.body.title.trim() : '';
  const description = typeof req.body?.description === 'string' ? req.body.description.trim() : '';
  const visibility = req.body?.visibility || 'public';
  const config = getLiveKitConfig();
  if (!config) return res.status(503).json({ error: 'LIVE streaming is not enabled on this server yet' });
  if (!title || title.length > 80 || description.length > 500) return res.status(400).json({ error: 'LIVE title or description is invalid' });
  if (!['public','followers','private'].includes(visibility)) return res.status(400).json({ error: 'Invalid LIVE visibility' });
  if (visibility !== 'public') return res.status(409).json({ error: 'Follower-only and private LIVE access require the invitation/follower rollout' });
  try {
    const id = randomUUID();
    const roomName = 'zlive_' + id.replace(/-/g, '');
    const { data: stream, error } = await supabaseAdmin.rpc('create_live_stream', {
      p_stream_id: id,
      p_creator_id: req.user.id,
      p_title: title,
      p_description: description,
      p_room_name: roomName,
    });
    if (error) throw error;
    return res.status(201).json({
      stream, livekitUrl: config.url,
      token: issueToken(req.user, roomName, config, true),
    });
  } catch (error) {
    if (error?.code === '23505') return res.status(409).json({ error: 'You already have an active LIVE stream' });
    console.error('[live] create failed:', error?.message || error);
    return res.status(503).json({ error: 'Could not start LIVE right now' });
  }
});

router.post('/:streamId/join', async (req, res) => {
  const streamId = req.params.streamId;
  if (!validId(streamId)) return res.status(400).json({ error: 'Invalid LIVE stream id' });
  const config = getLiveKitConfig();
  if (!config) return res.status(503).json({ error: 'LIVE streaming is not enabled on this server yet' });
  try {
    const stream = await getStream(streamId);
    if (!stream || stream.status !== 'live') return res.status(404).json({ error: 'LIVE stream has ended' });
    if (stream.visibility !== 'public' && stream.creator_id !== req.user.id) {
      return res.status(403).json({ error: 'This LIVE stream is not publicly available' });
    }
    if (stream.creator_id !== req.user.id && await hasBlockBetween(stream.creator_id, req.user.id)) {
      return res.status(403).json({ error: 'This LIVE stream is unavailable' });
    }
    const { data: role, error: joinError } = await supabaseAdmin.rpc('join_live_stream', {
      p_stream_id: streamId, p_user_id: req.user.id,
    });
    if (joinError) {
      if (joinError.code === 'P0001' && /full/i.test(joinError.message || '')) return res.status(409).json({ error: 'This LIVE audience is full' });
      if (joinError.code === '42501') return res.status(403).json({ error: 'This LIVE stream is not publicly available' });
      if (joinError.code === 'P0001') return res.status(404).json({ error: 'LIVE stream has ended' });
      throw joinError;
    }
    return res.json({
      stream, livekitUrl: config.url,
      token: issueToken(req.user, stream.room_name, config, role === 'creator'),
      role,
    });
  } catch (error) {
    console.error('[live] join failed:', error?.message || error);
    return res.status(503).json({ error: 'Could not join this LIVE stream' });
  }
});

router.post('/:streamId/leave', async (req, res) => {
  const streamId = req.params.streamId;
  if (!validId(streamId)) return res.status(400).json({ error: 'Invalid LIVE stream id' });
  try {
    const { error } = await supabaseAdmin.from('live_stream_participants').update({
      status: 'left', left_at: new Date().toISOString(),
    }).eq('stream_id', streamId).eq('user_id', req.user.id).eq('status', 'joined');
    if (error) throw error;
    return res.json({ left: true });
  } catch (error) {
    console.error('[live] leave failed:', error?.message || error);
    return res.status(503).json({ error: 'Could not leave LIVE stream' });
  }
});

router.get('/:streamId/comments', async (req, res) => {
  const streamId = req.params.streamId;
  if (!validId(streamId)) return res.status(400).json({ error: 'Invalid LIVE stream id' });
  try {
    const stream = await getStream(streamId);
    if (!stream || stream.status !== 'live') return res.status(404).json({ error: 'LIVE stream has ended' });
    if (stream.visibility !== 'public' && stream.creator_id !== req.user.id) return res.status(403).json({ error: 'This LIVE stream is not public' });
    const { data, error } = await supabaseAdmin.from('live_stream_comments')
      .select('id,stream_id,user_id,body,moderation_status,created_at')
      .eq('stream_id', streamId).eq('moderation_status', 'visible')
      .order('created_at', { ascending: false }).limit(50);
    if (error) throw error;
    return res.json({ comments: (data || []).reverse() });
  } catch (error) {
    console.error('[live] comments fetch failed:', error?.message || error);
    return res.status(503).json({ error: 'Could not load LIVE comments' });
  }
});

router.post('/:streamId/comment', makeLimiter({ windowMs: 10 * 1000, max: 5, error: 'Please slow down before posting another LIVE comment.' }), async (req, res) => {
  const streamId = req.params.streamId;
  const body = typeof req.body?.body === 'string' ? req.body.body.trim() : '';
  if (!validId(streamId)) return res.status(400).json({ error: 'Invalid LIVE stream id' });
  if (!body || body.length > 500) return res.status(400).json({ error: 'Comment must contain 1 to 500 characters' });
  try {
    const stream = await getStream(streamId);
    if (!stream || stream.status !== 'live') return res.status(404).json({ error: 'LIVE stream has ended' });
    if (!stream.allow_comments) return res.status(403).json({ error: 'Comments are disabled for this LIVE stream' });
    if (!await requireJoined(streamId, req.user.id)) return res.status(403).json({ error: 'Join this LIVE stream before commenting' });
    if (stream.creator_id !== req.user.id && await hasBlockBetween(stream.creator_id, req.user.id)) return res.status(403).json({ error: 'Comments are unavailable' });
    const { data, error } = await supabaseAdmin.from('live_stream_comments').insert({
      stream_id: streamId, user_id: req.user.id, body,
    }).select('id,stream_id,user_id,body,moderation_status,created_at').single();
    if (error) throw error;
    return res.status(201).json({ comment: data });
  } catch (error) {
    console.error('[live] comment failed:', error?.message || error);
    return res.status(503).json({ error: 'Could not post LIVE comment' });
  }
});

router.post('/:streamId/comments/:commentId/hide', async (req, res) => {
  const { streamId, commentId } = req.params;
  if (!validId(streamId) || !validId(commentId)) return res.status(400).json({ error: 'Invalid LIVE comment reference' });
  try {
    const stream = await getStream(streamId);
    if (!stream || stream.status !== 'live') return res.status(404).json({ error: 'LIVE stream has ended' });
    if (stream.creator_id !== req.user.id) return res.status(403).json({ error: 'Only the creator can moderate LIVE comments' });
    const { data, error } = await supabaseAdmin.from('live_stream_comments')
      .update({ moderation_status: 'hidden' })
      .eq('id', commentId).eq('stream_id', streamId)
      .select('id,moderation_status').maybeSingle();
    if (error) throw error;
    if (!data) return res.status(404).json({ error: 'LIVE comment not found' });
    return res.json({ hidden: true, comment: data });
  } catch (error) {
    console.error('[live] comment moderation failed:', error?.message || error);
    return res.status(503).json({ error: 'Could not moderate LIVE comment' });
  }
});

router.post('/:streamId/react', async (req, res) => {
  const streamId = req.params.streamId;
  const reaction = req.body?.reaction;
  if (!validId(streamId)) return res.status(400).json({ error: 'Invalid LIVE stream id' });
  if (!REACTIONS.has(reaction)) return res.status(400).json({ error: 'Unsupported LIVE reaction' });
  try {
    const stream = await getStream(streamId);
    if (!stream || stream.status !== 'live') return res.status(404).json({ error: 'LIVE stream has ended' });
    if (!await requireJoined(streamId, req.user.id)) return res.status(403).json({ error: 'Join this LIVE stream before reacting' });
    const { error } = await supabaseAdmin.from('live_stream_reactions').insert({
      stream_id: streamId, user_id: req.user.id, reaction,
    });
    if (error) throw error;
    return res.status(201).json({ accepted: true });
  } catch (error) {
    console.error('[live] reaction failed:', error?.message || error);
    return res.status(503).json({ error: 'Could not send LIVE reaction' });
  }
});

router.post('/:streamId/report', async (req, res) => {
  const streamId = req.params.streamId;
  const reason = req.body?.reason;
  const details = typeof req.body?.details === 'string' ? req.body.details.trim() : '';
  if (!validId(streamId)) return res.status(400).json({ error: 'Invalid LIVE stream id' });
  if (!REASONS.has(reason) || details.length > 1000) return res.status(400).json({ error: 'Invalid LIVE report' });
  try {
    const stream = await getStream(streamId);
    if (!stream || stream.status !== 'live') return res.status(404).json({ error: 'LIVE stream has ended' });
    if (stream.creator_id === req.user.id) return res.status(400).json({ error: 'Creators cannot report their own LIVE stream' });
    const { error } = await supabaseAdmin.from('live_stream_reports').upsert({
      stream_id: streamId, reporter_id: req.user.id, reason, details,
    }, { onConflict: 'stream_id,reporter_id' });
    if (error) throw error;
    return res.status(201).json({ reported: true });
  } catch (error) {
    console.error('[live] report failed:', error?.message || error);
    return res.status(503).json({ error: 'Could not submit LIVE report' });
  }
});

router.post('/:streamId/end', async (req, res) => {
  const streamId = req.params.streamId;
  if (!validId(streamId)) return res.status(400).json({ error: 'Invalid LIVE stream id' });
  try {
    const { data: ended, error } = await supabaseAdmin.rpc('end_live_stream', {
      p_stream_id: streamId, p_creator_id: req.user.id,
    });
    if (error) {
      if (error.code === '42501') return res.status(403).json({ error: 'Only the creator can end this LIVE stream' });
      throw error;
    }
    if (!ended) return res.status(404).json({ error: 'LIVE stream has ended' });
    return res.json({ ended: true });
  } catch (error) {
    console.error('[live] end failed:', error?.message || error);
    return res.status(503).json({ error: 'Could not end LIVE stream' });
  }
});

module.exports = router;
