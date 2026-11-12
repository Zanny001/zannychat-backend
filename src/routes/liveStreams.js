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

async function getBlockedUserIds(userId, otherIds) {
  const ids = [...new Set((otherIds || []).filter((id) => validId(id) && id !== userId))];
  if (!ids.length) return new Set();
  const [blockedByUser, blockedUser] = await Promise.all([
    supabaseAdmin.from('blocked_users').select('blocked_id').eq('blocker_id', userId).in('blocked_id', ids),
    supabaseAdmin.from('blocked_users').select('blocker_id').eq('blocked_id', userId).in('blocker_id', ids),
  ]);
  if (blockedByUser.error || blockedUser.error) throw blockedByUser.error || blockedUser.error;
  return new Set([
    ...(blockedByUser.data || []).map((row) => row.blocked_id),
    ...(blockedUser.data || []).map((row) => row.blocker_id),
  ]);
}

async function getProfileNames(userIds) {
  const ids = [...new Set((userIds || []).filter(validId))];
  if (!ids.length) return new Map();
  try {
    const { data, error } = await supabaseAdmin.from('profiles')
      .select('id,name').in('id', ids);
    if (error) throw error;
    return new Map((data || []).map((row) => [row.id, row.name]));
  } catch (error) {
    console.error('[live] comment display name lookup failed:', error?.message || error);
    return new Map();
  }
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

router.post('/creators/:creatorId/follow', async (req, res) => {
  const creatorId = req.params.creatorId;
  if (!validId(creatorId) || creatorId === req.user.id) return res.status(400).json({ error: 'Invalid LIVE creator' });
  try {
    if (await hasBlockBetween(creatorId, req.user.id)) return res.status(403).json({ error: 'This creator is unavailable' });
    const { data: creator, error: creatorError } = await supabaseAdmin.from('profiles')
      .select('id').eq('id', creatorId).maybeSingle();
    if (creatorError) throw creatorError;
    if (!creator) return res.status(404).json({ error: 'Creator not found' });
    const { error } = await supabaseAdmin.from('live_creator_follows').upsert(
      { follower_id: req.user.id, creator_id: creatorId }, { onConflict: 'follower_id,creator_id', ignoreDuplicates: true }
    );
    if (error) throw error;
    return res.json({ following: true, creatorId });
  } catch (error) {
    console.error('[live] follow failed:', error?.message || error);
    return res.status(503).json({ error: 'Could not follow this creator' });
  }
});

router.delete('/creators/:creatorId/follow', async (req, res) => {
  const creatorId = req.params.creatorId;
  if (!validId(creatorId) || creatorId === req.user.id) return res.status(400).json({ error: 'Invalid LIVE creator' });
  try {
    const { error } = await supabaseAdmin.from('live_creator_follows')
      .delete().eq('follower_id', req.user.id).eq('creator_id', creatorId);
    if (error) throw error;
    return res.json({ following: false, creatorId });
  } catch (error) {
    console.error('[live] unfollow failed:', error?.message || error);
    return res.status(503).json({ error: 'Could not unfollow this creator' });
  }
});

router.get('/following', async (req, res) => {
  try {
    const { data, error } = await supabaseAdmin.from('live_creator_follows')
      .select('creator_id,created_at').eq('follower_id', req.user.id)
      .order('created_at', { ascending: false }).limit(500);
    if (error) throw error;
    const creatorIds = (data || []).map((row) => row.creator_id);
    const { data: profiles, error: profileError } = creatorIds.length
      ? await supabaseAdmin.from('profiles').select('id,name,avatar_color').in('id', creatorIds)
      : { data: [], error: null };
    if (profileError) throw profileError;
    const profileById = new Map((profiles || []).map((profile) => [profile.id, profile]));
    const blockedIds = await getBlockedUserIds(req.user.id, creatorIds);
    return res.json({ following: (data || []).filter((row) => !blockedIds.has(row.creator_id)).map((row) => ({
      ...row, name: profileById.get(row.creator_id)?.name || 'ZannyChat creator',
      avatarColor: profileById.get(row.creator_id)?.avatar_color || null,
    })) });
  } catch (error) {
    console.error('[live] following list failed:', error?.message || error);
    return res.status(503).json({ error: 'Could not load followed creators' });
  }
});

router.get('/invite-candidates', async (req, res) => {
  try {
    const { data: memberships, error: membershipError } = await supabaseAdmin.from('conversation_participants')
      .select('conversation_id').eq('user_id', req.user.id).limit(500);
    if (membershipError) throw membershipError;
    const conversationIds = [...new Set((memberships || []).map((row) => row.conversation_id))];
    if (!conversationIds.length) return res.json({ candidates: [] });
    const { data: participants, error: participantError } = await supabaseAdmin.from('conversation_participants')
      .select('user_id').in('conversation_id', conversationIds).neq('user_id', req.user.id).limit(500);
    if (participantError) throw participantError;
    const candidateIds = [...new Set((participants || []).map((row) => row.user_id))];
    if (!candidateIds.length) return res.json({ candidates: [] });
    const blockedIds = await getBlockedUserIds(req.user.id, candidateIds);
    const visibleIds = candidateIds.filter((userId) => !blockedIds.has(userId));
    if (!visibleIds.length) return res.json({ candidates: [] });
    const { data: profiles, error: profileError } = await supabaseAdmin.from('profiles')
      .select('id,name,avatar_color').in('id', visibleIds).order('name', { ascending: true }).limit(100);
    if (profileError) throw profileError;
    return res.json({ candidates: profiles || [] });
  } catch (error) {
    console.error('[live] invite candidate lookup failed:', error?.message || error);
    return res.status(503).json({ error: 'Could not load invite contacts' });
  }
});

router.get('/invitations', async (req, res) => {
  try {
    const { data: invites, error: inviteError } = await supabaseAdmin.from('live_stream_invites')
      .select('stream_id,invited_by,created_at').eq('user_id', req.user.id)
      .eq('invitation_type', 'viewer').eq('status', 'pending')
      .order('created_at', { ascending: false }).limit(50);
    if (inviteError) throw inviteError;
    const streamIds = (invites || []).map((row) => row.stream_id);
    const { data: streams, error: streamError } = streamIds.length
      ? await supabaseAdmin.from('live_streams')
        .select('id,creator_id,title,description,allow_guests,visibility,status,started_at')
        .in('id', streamIds).eq('status', 'live')
      : { data: [], error: null };
    if (streamError) throw streamError;
    const streamById = new Map((streams || []).map((row) => [row.id, row]));
    const inviteRows = (invites || []).map((invite) => ({ ...invite, stream: streamById.get(invite.stream_id) || null }))
      .filter((invite) => invite.stream);
    const blockedIds = await getBlockedUserIds(req.user.id, inviteRows.map((invite) => invite.stream.creator_id));
    return res.json({ invitations: inviteRows.filter((invite) => !blockedIds.has(invite.stream.creator_id)) });
  } catch (error) {
    console.error('[live] invitation list failed:', error?.message || error);
    return res.status(503).json({ error: 'Could not load LIVE invitations' });
  }
});

router.get('/following/streams', async (req, res) => {
  try {
    const { data: follows, error: followError } = await supabaseAdmin.from('live_creator_follows')
      .select('creator_id').eq('follower_id', req.user.id).limit(500);
    if (followError) throw followError;
    const creatorIds = (follows || []).map((row) => row.creator_id);
    if (!creatorIds.length) return res.json({ streams: [] });
    const { data, error } = await supabaseAdmin.from('live_streams')
      .select('id,creator_id,title,description,visibility,allow_guests,started_at')
      .eq('status', 'live').in('visibility', ['public','followers'])
      .in('creator_id', creatorIds).order('started_at', { ascending: false }).limit(50);
    if (error) throw error;
    const blockedIds = await getBlockedUserIds(req.user.id, (data || []).map((stream) => stream.creator_id));
    const visible = (data || []).filter((stream) => !blockedIds.has(stream.creator_id))
      .map((stream) => ({ ...stream, is_creator: stream.creator_id === req.user.id }));
    return res.json({ streams: visible });
  } catch (error) {
    console.error('[live] followed stream discovery failed:', error?.message || error);
    return res.status(503).json({ error: 'Could not load followed creators' });
  }
});

router.get('/', async (req, res) => {
  try {
    const { data, error } = await supabaseAdmin.from('live_streams')
      .select('id,creator_id,title,description,started_at,viewer_limit')
      .eq('status', 'live').eq('visibility', 'public')
      .order('started_at', { ascending: false }).limit(50);
    if (error) throw error;
    const blockedIds = await getBlockedUserIds(req.user.id, (data || []).map((stream) => stream.creator_id));
    const visible = (data || []).filter((stream) => !blockedIds.has(stream.creator_id))
      .map((stream) => ({ ...stream, is_creator: stream.creator_id === req.user.id }));
    return res.json({ streams: visible });
  } catch (error) {
    console.error('[live] discover failed:', error?.message || error);
    return res.status(503).json({ error: 'LIVE discovery is temporarily unavailable' });
  }
});

router.post('/', async (req, res) => {
  const title = typeof req.body?.title === 'string' ? req.body.title.trim() : '';
  const description = typeof req.body?.description === 'string' ? req.body.description.trim() : '';
  const visibility = req.body?.visibility || 'public';
  const inviteeIds = Array.isArray(req.body?.inviteeIds) ? req.body.inviteeIds : [];
  const config = getLiveKitConfig();
  if (!config) return res.status(503).json({ error: 'LIVE is not configured on this server. Set LIVEKIT_URL, LIVEKIT_API_KEY and LIVEKIT_API_SECRET on the backend service.' });
  if (!title || title.length > 80 || description.length > 500) return res.status(400).json({ error: 'LIVE title or description is invalid' });
  if (!['public','followers','private'].includes(visibility)) return res.status(400).json({ error: 'Invalid LIVE visibility' });
  if (inviteeIds.length > 100 || inviteeIds.some((id) => !validId(id)) || new Set(inviteeIds).size !== inviteeIds.length) return res.status(400).json({ error: 'Invalid private LIVE invitees' });
  if (visibility === 'private' && inviteeIds.length === 0) return res.status(400).json({ error: 'Private LIVE requires at least one invitee' });
  if (visibility !== 'private' && inviteeIds.length > 0) return res.status(400).json({ error: 'Invitees are only valid for private LIVE' });
  const allowGuests = req.body?.allowGuests === true;
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
      p_visibility: visibility,
      p_allow_guests: allowGuests,
      p_invited_user_ids: inviteeIds,
    });
    if (error) throw error;
    return res.status(201).json({
      stream, livekitUrl: config.url,
      token, role: 'creator', canModerate: true,
    });
  } catch (error) {
    if (error?.code === '23505') return res.status(409).json({ error: 'You already have an active LIVE stream' });
    if (error?.code === '42501') return res.status(403).json({ error: 'A blocked account cannot be invited to this LIVE stream' });
    if (error?.code === '22023' || error?.code === '23503') return res.status(400).json({ error: 'LIVE details or invitees are invalid' });
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
    const canPublish = role === 'creator' || role === 'guest';
    const token = issueToken(req.user, stream.room_name, config, canPublish);
    const canModerate = await canModerateLive(stream, req.user.id);
    return res.json({
      stream, livekitUrl: config.url,
      token, role, canPublish, canModerate,
    });
  } catch (error) {
    console.error('[live] join failed:', error?.message || error);
    return res.status(503).json({ error: 'Could not join this LIVE stream' });
  }
});

router.post('/:streamId/invites', async (req, res) => {
  const streamId = req.params.streamId;
  const userIds = Array.isArray(req.body?.userIds) ? [...new Set(req.body.userIds.filter(validId))] : [];
  if (!validId(streamId) || userIds.length < 1 || userIds.length > 100) {
    return res.status(400).json({ error: 'Provide between 1 and 100 valid invitees' });
  }
  try {
    const stream = await getStream(streamId);
    if (!stream || stream.status !== 'live') return res.status(404).json({ error: 'LIVE stream has ended' });
    if (stream.creator_id !== req.user.id) return res.status(403).json({ error: 'Only the creator can invite viewers' });
    if (stream.visibility !== 'private') return res.status(409).json({ error: 'Invitations are only required for private LIVE streams' });
    const invitees = userIds.filter((id) => id !== req.user.id);
    if (!invitees.length) return res.status(400).json({ error: 'At least one invitee other than the creator is required' });
    const blockedInvitees = await getBlockedUserIds(stream.creator_id, invitees);
    if (blockedInvitees.size) return res.status(403).json({ error: 'A blocked account cannot be invited' });
    const { data: profiles, error: profileError } = await supabaseAdmin.from('profiles')
      .select('id').in('id', invitees);
    if (profileError) throw profileError;
    const existing = new Set((profiles || []).map((row) => row.id));
    if (invitees.some((id) => !existing.has(id))) return res.status(404).json({ error: 'One or more invitees do not exist' });
    const rows = invitees.map((userId) => ({
      stream_id: streamId, user_id: userId, invited_by: req.user.id,
      invitation_type: 'viewer', status: 'pending', requested_by: null,
    }));
    const { error } = await supabaseAdmin.from('live_stream_invites').upsert(rows, { onConflict: 'stream_id,user_id,invitation_type' });
    if (error) throw error;
    return res.json({ invited: invitees.length });
  } catch (error) {
    console.error('[live] invite creation failed:', error?.message || error);
    return res.status(503).json({ error: 'Could not invite viewers to this LIVE stream' });
  }
});

router.get('/:streamId/guest-status', async (req, res) => {
  const streamId = req.params.streamId;
  if (!validId(streamId)) return res.status(400).json({ error: 'Invalid LIVE stream id' });
  try {
    const { data, error } = await supabaseAdmin.from('live_stream_invites')
      .select('status').eq('stream_id', streamId).eq('user_id', req.user.id)
      .eq('invitation_type', 'guest').maybeSingle();
    if (error) throw error;
    return res.json({ status: data?.status || 'none' });
  } catch (error) {
    console.error('[live] guest status fetch failed:', error?.message || error);
    return res.status(503).json({ error: 'Could not check guest request status' });
  }
});

router.post('/:streamId/guest-requests', async (req, res) => {
  const streamId = req.params.streamId;
  if (!validId(streamId)) return res.status(400).json({ error: 'Invalid LIVE stream id' });
  try {
    const stream = await getStream(streamId);
    if (!stream || stream.status !== 'live') return res.status(404).json({ error: 'LIVE stream has ended' });
    if (!stream.allow_guests) return res.status(409).json({ error: 'Guest participation is disabled for this LIVE stream' });
    const participant = await requireJoined(streamId, req.user.id);
    if (!participant || participant.role !== 'viewer') return res.status(403).json({ error: 'Only a joined viewer can request guest access' });
    if (stream.creator_id === req.user.id) return res.status(400).json({ error: 'The creator is already a publisher' });
    if (await hasBlockBetween(stream.creator_id, req.user.id)) return res.status(403).json({ error: 'Guest access is unavailable' });
    const { error } = await supabaseAdmin.from('live_stream_invites').upsert({
      stream_id: streamId, user_id: req.user.id, invited_by: stream.creator_id,
      requested_by: req.user.id, invitation_type: 'guest', status: 'requested',
    }, { onConflict: 'stream_id,user_id,invitation_type' });
    if (error) throw error;
    return res.status(202).json({ requested: true });
  } catch (error) {
    console.error('[live] guest request failed:', error?.message || error);
    return res.status(503).json({ error: 'Could not request guest access' });
  }
});

router.get('/:streamId/guest-requests', async (req, res) => {
  const streamId = req.params.streamId;
  if (!validId(streamId)) return res.status(400).json({ error: 'Invalid LIVE stream id' });
  try {
    const stream = await getStream(streamId);
    if (!stream || stream.status !== 'live') return res.status(404).json({ error: 'LIVE stream has ended' });
    if (stream.creator_id !== req.user.id) return res.status(403).json({ error: 'Only the creator can review guest requests' });
    const { data, error } = await supabaseAdmin.from('live_stream_invites')
      .select('user_id,requested_by,status,created_at')
      .eq('stream_id', streamId).eq('invitation_type', 'guest').eq('status', 'requested')
      .order('created_at', { ascending: true }).limit(100);
    if (error) throw error;
    const userIds = (data || []).map((row) => row.user_id);
    const { data: profiles, error: profileError } = userIds.length
      ? await supabaseAdmin.from('profiles').select('id,name').in('id', userIds)
      : { data: [], error: null };
    if (profileError) throw profileError;
    const names = new Map((profiles || []).map((row) => [row.id, row.name]));
    return res.json({ requests: (data || []).map((row) => ({ ...row, name: names.get(row.user_id) || 'ZannyChat user' })) });
  } catch (error) {
    console.error('[live] guest request list failed:', error?.message || error);
    return res.status(503).json({ error: 'Could not load guest requests' });
  }
});

router.patch('/:streamId/guest-requests/:userId', async (req, res) => {
  const { streamId, userId } = req.params;
  const status = req.body?.status;
  if (!validId(streamId) || !validId(userId) || !['accepted','declined'].includes(status)) {
    return res.status(400).json({ error: 'Invalid guest request decision' });
  }
  try {
    const stream = await getStream(streamId);
    if (!stream || stream.status !== 'live') return res.status(404).json({ error: 'LIVE stream has ended' });
    if (stream.creator_id !== req.user.id) return res.status(403).json({ error: 'Only the creator can approve guest requests' });
    if (!stream.allow_guests) return res.status(409).json({ error: 'Guest participation is disabled' });
    if (await hasBlockBetween(stream.creator_id, userId)) return res.status(403).json({ error: 'Guest access is unavailable' });
    const participant = await requireJoined(streamId, userId);
    if (!participant || participant.role !== 'viewer') return res.status(409).json({ error: 'The requester is no longer a joined viewer' });
    const { data, error } = await supabaseAdmin.from('live_stream_invites')
      .update({ status, invited_by: req.user.id, updated_at: new Date().toISOString() })
      .eq('stream_id', streamId).eq('user_id', userId)
      .eq('invitation_type', 'guest').eq('status', 'requested')
      .select('user_id,status').maybeSingle();
    if (error) throw error;
    if (!data) return res.status(404).json({ error: 'Pending guest request not found' });
    return res.json({ request: data });
  } catch (error) {
    console.error('[live] guest request decision failed:', error?.message || error);
    return res.status(503).json({ error: 'Could not update guest request' });
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
    if (!await requireJoined(streamId, req.user.id)) return res.status(403).json({ error: 'Join this LIVE stream before reading comments' });
    if (stream.creator_id !== req.user.id && await hasBlockBetween(stream.creator_id, req.user.id)) {
      return res.status(403).json({ error: 'This LIVE stream is unavailable' });
    }
    const { data, error } = await supabaseAdmin.from('live_stream_comments')
      .select('id,stream_id,user_id,body,moderation_status,created_at')
      .eq('stream_id', streamId).eq('moderation_status', 'visible')
      .order('created_at', { ascending: false }).limit(50);
    if (error) throw error;
    const ordered = (data || []).reverse();
    const names = await getProfileNames(ordered.map((comment) => comment.user_id));
    const comments = ordered.map((row) => {
      const { user_id: _userId, ...comment } = row;
      return { ...comment, user_name: names.get(_userId) || 'ZannyChat user' };
    });
    return res.json({ comments });
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
    const names = await getProfileNames([req.user.id]);
    const { user_id: _userId, ...comment } = data;
    return res.status(201).json({
      comment: { ...comment, user_name: names.get(_userId) || 'ZannyChat user' },
    });
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
    }).eq('stream_id', streamId).eq('id', reportId).in('status', ['open','reviewing'])
      .select('id,status,reviewed_by,reviewed_at').maybeSingle();
    if (error) throw error;
    if (!data) return res.status(404).json({ error: 'Open or reviewing LIVE report not found' });
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
