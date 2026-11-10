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

async function canModerateLive(stream, userId) {
  if (stream.creator_id === userId) return true;
  const { data, error } = await supabaseAdmin.from('live_stream_moderators')
    .select('user_id').eq('stream_id', stream.id).eq('user_id', userId).maybeSingle();
  if (error) throw error;
  return Boolean(data);
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
    const token = issueToken(req.user, roomName, config, true);
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
      token, role: 'creator', canModerate: true,
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
    const token = issueToken(req.user, stream.room_name, config, stream.creator_id === req.user.id);
    const { data: role, error: joinError } = await supabaseAdmin.rpc('join_live_stream', {
      p_stream_id: streamId, p_user_id: req.user.id,
    });
    if (joinError) {
      if (joinError.code === 'P0001' && /full/i.test(joinError.message || '')) return res.status(409).json({ error: 'This LIVE audience is full' });
      if (joinError.code === '42501') return res.status(403).json({ error: 'This LIVE stream is not publicly available' });
      if (joinError.code === 'P0001') return res.status(404).json({ error: 'LIVE stream has ended' });
      throw joinError;
    }
    const canModerate = await canModerateLive(stream, req.user.id);
    return res.json({
      stream, livekitUrl: config.url,
      token, role, canModerate,
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
    const { data: left, error } = await supabaseAdmin.rpc('leave_live_stream', {
      p_stream_id: streamId, p_user_id: req.user.id,
    });
    if (error) {
      if (error.code === '42501') return res.status(403).json({ error: 'The creator must end this LIVE stream' });
      throw error;
    }
    return res.json({ left: left === true });
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
    if (stream.creator_id !== req.user.id && await hasBlockBetween(stream.creator_id, req.user.id)) {
      return res.status(403).json({ error: 'This LIVE stream is unavailable' });
    }
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
    if (!await canModerateLive(stream, req.user.id)) return res.status(403).json({ error: 'Only the creator or an appointed LIVE moderator can moderate comments' });
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
    if (stream.creator_id !== req.user.id && await hasBlockBetween(stream.creator_id, req.user.id)) {
      return res.status(403).json({ error: 'Reactions are unavailable' });
    }
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


router.get('/:streamId/participants', async (req, res) => {
  const streamId = req.params.streamId;
  if (!validId(streamId)) return res.status(400).json({ error: 'Invalid LIVE stream id' });
  try {
    const stream = await getStream(streamId);
    if (!stream || stream.status !== 'live') return res.status(404).json({ error: 'LIVE stream has ended' });
    if (stream.creator_id !== req.user.id) return res.status(403).json({ error: 'Only the creator can manage LIVE participants' });
    const { data: joined, error: joinedError } = await supabaseAdmin.from('live_stream_participants')
      .select('user_id,joined_at').eq('stream_id', streamId).eq('role', 'viewer').eq('status', 'joined')
      .order('joined_at', { ascending: true }).limit(500);
    if (joinedError) throw joinedError;
    const { data: moderators, error: moderatorsError } = await supabaseAdmin.from('live_stream_moderators')
      .select('user_id').eq('stream_id', streamId);
    if (moderatorsError) throw moderatorsError;
    const joinedById = new Map((joined || []).map((row) => [row.user_id, row]));
    const moderatorIds = new Set((moderators || []).map((row) => row.user_id));
    const userIds = [...new Set([...joinedById.keys(), ...moderatorIds])];
    const { data: profiles, error: profilesError } = userIds.length
      ? await supabaseAdmin.from('profiles').select('id,name').in('id', userIds)
      : { data: [], error: null };
    if (profilesError) throw profilesError;
    const names = new Map((profiles || []).map((row) => [row.id, row.name]));
    return res.json({ participants: userIds.map((userId) => ({
      userId, name: names.get(userId) || 'ZannyChat user',
      joinedAt: joinedById.get(userId)?.joined_at || null,
      joined: joinedById.has(userId), moderator: moderatorIds.has(userId),
    })) });
  } catch (error) {
    console.error('[live] participants fetch failed:', error?.message || error);
    return res.status(503).json({ error: 'Could not load LIVE participants' });
  }
});

router.post('/:streamId/moderators', async (req, res) => {
  const streamId = req.params.streamId;
  const userId = typeof req.body?.userId === 'string' ? req.body.userId.trim() : '';
  if (!validId(streamId) || !validId(userId)) return res.status(400).json({ error: 'Invalid LIVE moderator reference' });
  try {
    const stream = await getStream(streamId);
    if (!stream || stream.status !== 'live') return res.status(404).json({ error: 'LIVE stream has ended' });
    if (stream.creator_id !== req.user.id) return res.status(403).json({ error: 'Only the creator can appoint LIVE moderators' });
    if (userId === stream.creator_id) return res.status(400).json({ error: 'The creator is already the stream administrator' });
    const participant = await requireJoined(streamId, userId);
    if (!participant || participant.role !== 'viewer') return res.status(400).json({ error: 'Only a joined viewer can be appointed as a LIVE moderator' });
    const { error } = await supabaseAdmin.from('live_stream_moderators').upsert({
      stream_id: streamId, user_id: userId, appointed_by: req.user.id,
    }, { onConflict: 'stream_id,user_id', ignoreDuplicates: true });
    if (error) throw error;
    return res.json({ userId, moderator: true });
  } catch (error) {
    console.error('[live] moderator appointment failed:', error?.message || error);
    return res.status(503).json({ error: 'Could not appoint LIVE moderator' });
  }
});

router.delete('/:streamId/moderators/:userId', async (req, res) => {
  const { streamId, userId } = req.params;
  if (!validId(streamId) || !validId(userId)) return res.status(400).json({ error: 'Invalid LIVE moderator reference' });
  try {
    const stream = await getStream(streamId);
    if (!stream) return res.status(404).json({ error: 'LIVE stream not found' });
    if (stream.creator_id !== req.user.id) return res.status(403).json({ error: 'Only the creator can remove LIVE moderators' });
    const { error } = await supabaseAdmin.from('live_stream_moderators')
      .delete().eq('stream_id', streamId).eq('user_id', userId);
    if (error) throw error;
    return res.json({ userId, moderator: false });
  } catch (error) {
    console.error('[live] moderator removal failed:', error?.message || error);
    return res.status(503).json({ error: 'Could not remove LIVE moderator' });
  }
});

router.get('/:streamId/reports', async (req, res) => {
  const streamId = req.params.streamId;
  if (!validId(streamId)) return res.status(400).json({ error: 'Invalid LIVE stream id' });
  try {
    const stream = await getStream(streamId);
    if (!stream) return res.status(404).json({ error: 'LIVE stream not found' });
    if (!await canModerateLive(stream, req.user.id)) return res.status(403).json({ error: 'Only the creator or appointed LIVE moderators can review reports' });
    const { data, error } = await supabaseAdmin.from('live_stream_reports')
      .select('id,stream_id,reporter_id,reason,details,status,created_at,reviewed_by,reviewed_at')
      .eq('stream_id', streamId)
      .order('created_at', { ascending: true }).limit(100);
    if (error) throw error;
    return res.json({ reports: data || [] });
  } catch (error) {
    console.error('[live] report queue failed:', error?.message || error);
    return res.status(503).json({ error: 'Could not load LIVE reports' });
  }
});

router.patch('/:streamId/reports/:reportId', async (req, res) => {
  const { streamId, reportId } = req.params;
  const status = req.body?.status;
  if (!validId(streamId) || !validId(reportId)) return res.status(400).json({ error: 'Invalid LIVE report reference' });
  if (!['reviewing','resolved','dismissed'].includes(status)) return res.status(400).json({ error: 'Invalid LIVE report status' });
  try {
    const stream = await getStream(streamId);
    if (!stream) return res.status(404).json({ error: 'LIVE stream not found' });
    if (!await canModerateLive(stream, req.user.id)) return res.status(403).json({ error: 'Only the creator or appointed LIVE moderators can review reports' });
    const reviewedAt = status === 'reviewing' ? null : new Date().toISOString();
    const { data, error } = await supabaseAdmin.from('live_stream_reports').update({
      status, reviewed_by: req.user.id, reviewed_at: reviewedAt,
    }).eq('stream_id', streamId).eq('id', reportId)
      .select('id,status,reviewed_by,reviewed_at').maybeSingle();
    if (error) throw error;
    if (!data) return res.status(404).json({ error: 'LIVE report not found' });
    return res.json({ report: data });
  } catch (error) {
    console.error('[live] report review failed:', error?.message || error);
    return res.status(503).json({ error: 'Could not update LIVE report' });
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
