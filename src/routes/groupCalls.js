const express = require('express');
const { randomUUID } = require('node:crypto');
const { requireAuth } = require('../middleware/requireAuth');
const { makeLimiter } = require('../middleware/rateLimit');
const { supabaseAdmin } = require('../config/supabaseAdmin');
const { createLiveKitToken, getLiveKitConfig } = require('../services/livekitToken');
const { cleanupEndedGroupCallMedia } = require('../jobs/groupCallMediaCleanup');
const { sendPushToUser } = require('../config/pushClient');

const router = express.Router();
router.use(requireAuth, makeLimiter({ windowMs: 60 * 1000, max: 20, error: 'Group-call actions are rate-limited.' }));

function validId(value) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(String(value || ''));
}

function tokenFor(user, roomName, config) {
  return createLiveKitToken({
    identity: user.id,
    name: user.user_metadata?.name || user.user_metadata?.full_name || 'ZannyChat member',
    room: roomName,
    canPublish: true,
    canSubscribe: true,
    config,
  });
}

async function getGroupMembership(conversationId, userId) {
  const { data: conversation, error: conversationError } = await supabaseAdmin
    .from('conversations').select('id,is_group,name').eq('id', conversationId).maybeSingle();
  if (conversationError) throw conversationError;
  if (!conversation || !conversation.is_group) return { error: 'Group conversation not found', status: 404 };
  const { data: membership, error: membershipError } = await supabaseAdmin
    .from('conversation_participants').select('user_id,is_admin')
    .eq('conversation_id', conversationId).eq('user_id', userId).maybeSingle();
  if (membershipError) throw membershipError;
  if (!membership) return { error: 'You are not a member of this group', status: 403 };
  const { data: members, error: membersError } = await supabaseAdmin
    .from('conversation_participants').select('user_id').eq('conversation_id', conversationId);
  if (membersError) throw membersError;
  return { conversation, membership, members: members || [] };
}

router.post('/upgrade/:callId', async (req, res) => {
  const callId = String(req.params.callId || '');
  const userIds = Array.isArray(req.body?.userIds) ? req.body.userIds : [];
  if (!validId(callId) || userIds.length < 1 || userIds.length > 14
      || userIds.some((id) => !validId(id)) || new Set(userIds).size !== userIds.length) {
    return res.status(400).json({ error: 'Choose one to fourteen valid people to add' });
  }
  const config = getLiveKitConfig();
  if (!config) return res.status(503).json({ error: 'Group calling is not enabled on this server yet' });
  try {
    const { data: call, error: callError } = await supabaseAdmin.from('call_sessions')
      .select('id,conversation_id,caller_id,callee_id,call_type,status,group_room_id,last_activity_at')
      .eq('id', callId).maybeSingle();
    if (callError) throw callError;
    if (!call || ![call.caller_id, call.callee_id].includes(req.user.id)) {
      return res.status(404).json({ error: 'Active call not found' });
    }
    if (call.status !== 'accepted' || call.group_room_id) {
      return res.status(409).json({ error: 'This call can no longer be upgraded' });
    }

    const roomId = randomUUID();
    const roomName = 'zgc_' + roomId.replace(/-/g, '');
    const { data: room, error: promoteError } = await supabaseAdmin.rpc('promote_direct_call_to_group_room', {
      p_call_id: callId,
      p_actor_user_id: req.user.id,
      p_room_id: roomId,
      p_room_name: roomName,
      p_invited_user_ids: userIds,
    });
    if (promoteError) {
      if (promoteError.code === 'P0001') return res.status(409).json({ error: 'The call is no longer active. Start a new call and try again.' });
      if (promoteError.code === '23505') return res.status(409).json({ error: 'One of the selected people is already in another call.' });
      if (promoteError.code === '42501') return res.status(403).json({ error: 'One or more selected people cannot be added to this call.' });
      if (promoteError.code === '22023') return res.status(400).json({ error: 'The selected people or call settings are invalid.' });
      throw promoteError;
    }

    const invitationResults = await Promise.allSettled(userIds.map((userId) => sendPushToUser(userId, {
      title: call.call_type === 'video' ? 'Video call invitation' : 'Voice call invitation',
      body: `${req.user.user_metadata?.name || req.user.user_metadata?.full_name || 'A ZannyChat member'} added you to an ongoing ${call.call_type} call`,
      data: { type: 'group_call_invite', groupCallId: roomId, conversationId: call.conversation_id, callType: call.call_type },
    })));
    const pushAccepted = invitationResults.filter((result) => result.status === 'fulfilled' && Number(result.value?.sent) > 0).length;
    return res.status(201).json({
      room,
      livekitUrl: config.url,
      token: tokenFor(req.user, roomName, config),
      invitedCount: userIds.length,
      pushAcceptedDevices: pushAccepted,
    });
  } catch (error) {
    console.error('[group-calls] direct-call upgrade failed:', error?.message || error);
    return res.status(503).json({ error: 'Could not add people to this call' });
  }
});

router.post('/', async (req, res) => {
  const conversationId = String(req.body?.conversationId || '');
  const callType = req.body?.callType === 'video' ? 'video' : 'audio';
  if (!validId(conversationId)) return res.status(400).json({ error: 'Invalid group conversation id' });
  const config = getLiveKitConfig();
  if (!config) return res.status(503).json({ error: 'Group calling is not enabled on this server yet' });
  try {
    const group = await getGroupMembership(conversationId, req.user.id);
    if (group.error) return res.status(group.status).json({ error: group.error });
    if (group.members.length < 2 || group.members.length > 16) {
      return res.status(409).json({ error: 'Group calls currently support 2 to 16 group members' });
    }
    const { data: blocks, error: blocksError } = await supabaseAdmin.from('blocked_users')
      .select('blocker_id,blocked_id')
      .or(`blocker_id.eq.${req.user.id},blocked_id.eq.${req.user.id}`);
    if (blocksError) throw blocksError;
    const blockedIds = new Set((blocks || []).map((row) =>
      row.blocker_id === req.user.id ? row.blocked_id : row.blocker_id
    ));
    const eligibleMembers = group.members.filter((member) =>
      member.user_id === req.user.id || !blockedIds.has(member.user_id)
    );
    if (eligibleMembers.length < 2) return res.status(409).json({ error: 'No other eligible group members can join this call' });
    const roomId = randomUUID();
    const roomName = 'zgc_' + roomId.replace(/-/g, '');
    const invitedUserIds = eligibleMembers
      .filter((member) => member.user_id !== req.user.id)
      .map((member) => member.user_id);
    const token = tokenFor(req.user, roomName, config);
    const { data: room, error: roomError } = await supabaseAdmin.rpc('create_group_call_room', {
      p_conversation_id: conversationId,
      p_host_user_id: req.user.id,
      p_room_id: roomId,
      p_room_name: roomName,
      p_call_type: callType,
      p_max_participants: eligibleMembers.length,
      p_invited_user_ids: invitedUserIds,
    });
    if (roomError) {
      if (roomError.code === '23505') return res.status(409).json({ error: 'This group already has an active call' });
      if (roomError.code === '42501') return res.status(403).json({ error: 'Group membership changed. Refresh the group and try again.' });
      throw roomError;
    }
    const invitationResults = await Promise.allSettled(eligibleMembers
      .filter((member) => member.user_id !== req.user.id)
      .map((member) => sendPushToUser(member.user_id, {
        title: callType === 'video' ? 'Incoming group video call' : 'Incoming group audio call',
        body: `${req.user.user_metadata?.name || req.user.user_metadata?.full_name || 'A group member'} started a call in ${group.conversation.name || 'your group'}`,
        data: { type: 'group_call_invite', groupCallId: roomId, conversationId, callType },
      })));
    const pushAccepted = invitationResults.filter((result) => result.status === 'fulfilled' && Number(result.value?.sent) > 0).length;
    return res.status(201).json({
      room,
      livekitUrl: config.url,
      token,
      invitedCount: Math.max(0, eligibleMembers.length - 1),
      pushAcceptedDevices: pushAccepted,
    });
  } catch (error) {
    if (error?.code === '23505') return res.status(409).json({ error: 'This group already has an active call' });
    console.error('[group-calls] create failed:', error?.message || error);
    return res.status(503).json({ error: 'Could not start this group call' });
  }
});

router.get('/history', async (req, res) => {
  const limit = Math.max(1, Math.min(Number(req.query?.limit) || 100, 200));
  try {
    const { data: participants, error: participantError } = await supabaseAdmin.from('group_call_participants')
      .select('room_id,role,status,joined_at,left_at,invited_at')
      .eq('user_id', req.user.id)
      .order('invited_at', { ascending: false }).limit(limit);
    if (participantError) throw participantError;
    const ids = [...new Set((participants || []).map((row) => row.room_id))];
    if (!ids.length) return res.json({ calls: [] });
    const { data: rooms, error: roomError } = await supabaseAdmin.from('group_call_rooms')
      .select('id,conversation_id,host_user_id,call_type,status,created_at,started_at,ended_at')
      .in('id', ids);
    if (roomError) throw roomError;
    const conversationIds = [...new Set((rooms || []).map((row) => row.conversation_id))];
    const { data: conversations, error: conversationError } = await supabaseAdmin.from('conversations')
      .select('id,name').in('id', conversationIds);
    if (conversationError) throw conversationError;
    const roomsById = Object.fromEntries((rooms || []).map((room) => [room.id, room]));
    const namesById = Object.fromEntries((conversations || []).map((conversation) => [conversation.id, conversation.name]));
    const calls = (participants || []).map((participant) => {
      const room = roomsById[participant.room_id];
      if (!room) return null;
      const invitationExpired = participant.status === 'invited'
        && participant.invited_at
        && Date.parse(participant.invited_at) <= Date.now() - 2 * 60 * 1000;
      const neverJoined = !participant.joined_at && ['invited','left'].includes(participant.status);
      const status = participant.status === 'declined' ? 'declined'
        : neverJoined && (room.status === 'ended' || invitationExpired) ? 'missed'
        : participant.status === 'left' || room.status === 'ended' ? 'ended'
        : participant.status === 'joined' ? 'active' : 'ringing';
      const finishAt = participant.left_at || room.ended_at;
      const durationSeconds = participant.joined_at && finishAt
        ? Math.max(0, Math.floor((Date.parse(finishAt) - Date.parse(participant.joined_at)) / 1000))
        : 0;
      return {
        id: room.id, conversation_id: room.conversation_id,
        caller_id: room.host_user_id, callee_id: req.user.id,
        call_type: room.call_type || 'audio', status,
        created_at: room.created_at, accepted_at: participant.joined_at,
        ended_at: participant.left_at || room.ended_at,
        direction: room.host_user_id === req.user.id ? 'outgoing' : 'incoming',
        participantName: namesById[room.conversation_id] || 'Group call',
        avatarColor: '#6557D9', durationSeconds, isGroupCall: true,
      };
    }).filter(Boolean);
    return res.json({ calls });
  } catch (error) {
    console.error('[group-calls] history failed:', error?.message || error);
    return res.status(503).json({ error: 'Could not load group call history' });
  }
});

router.post('/:roomId/join', async (req, res) => {
  const roomId = req.params.roomId;
  if (!validId(roomId)) return res.status(400).json({ error: 'Invalid group call id' });
  const config = getLiveKitConfig();
  if (!config) return res.status(503).json({ error: 'Group calling is not enabled on this server yet' });
  try {
    const { data: room, error: roomError } = await supabaseAdmin.from('group_call_rooms')
      .select('id,conversation_id,host_user_id,room_name,status,max_participants,source_call_id')
      .eq('id', roomId).maybeSingle();
    if (roomError) throw roomError;
    if (!room || !['ringing','active'].includes(room.status)) return res.status(404).json({ error: 'Group call is no longer active' });
    const token = tokenFor(req.user, room.room_name, config);
    let joinError = null;
    if (room.source_call_id) {
      const { error } = await supabaseAdmin.rpc('join_direct_call_room', {
        p_room_id: roomId, p_user_id: req.user.id,
      });
      joinError = error;
    } else {
      const group = await getGroupMembership(room.conversation_id, req.user.id);
      if (group.error) return res.status(group.status).json({ error: group.error });
      const { error } = await supabaseAdmin.rpc('join_group_call_room', {
        p_room_id: roomId, p_user_id: req.user.id,
      });
      joinError = error;
    }
    if (joinError) {
      if (joinError.code === 'P0001' && /full/i.test(joinError.message || '')) return res.status(409).json({ error: 'This group call is full' });
      if (joinError.code === 'P0001' && /invitation has expired/i.test(joinError.message || '')) return res.status(410).json({ error: 'This group-call invitation has expired' });
      if (joinError.code === '42501') return res.status(403).json({ error: 'You are not a member of this group' });
      if (joinError.code === 'P0001') return res.status(404).json({ error: 'Group call is no longer active' });
      throw joinError;
    }
    return res.json({ room, livekitUrl: config.url, token });
  } catch (error) {
    console.error('[group-calls] join failed:', error?.message || error);
    return res.status(503).json({ error: 'Could not join this group call' });
  }
});

router.post('/:roomId/invite', async (req, res) => {
  const roomId = req.params.roomId;
  const userIds = Array.isArray(req.body?.userIds) ? req.body.userIds : [];
  if (!validId(roomId) || userIds.length < 1 || userIds.length > 14
      || userIds.some((id) => !validId(id)) || new Set(userIds).size !== userIds.length) {
    return res.status(400).json({ error: 'Choose one to fourteen valid people to invite' });
  }
  try {
    const { data: room, error: roomError } = await supabaseAdmin.from('group_call_rooms')
      .select('id,conversation_id,host_user_id,call_type,status,source_call_id')
      .eq('id', roomId).maybeSingle();
    if (roomError) throw roomError;
    if (!room || !['ringing','active'].includes(room.status)) {
      return res.status(404).json({ error: 'This call is no longer active' });
    }
    if (!room.source_call_id) {
      const group = await getGroupMembership(room.conversation_id, req.user.id);
      if (group.error) return res.status(group.status).json({ error: group.error });
      if (req.user.id !== room.host_user_id && !group.membership.is_admin) {
        return res.status(403).json({ error: 'Only the call host or a group admin can invite members' });
      }
    } else if (req.user.id !== room.host_user_id) {
      return res.status(403).json({ error: 'Only the call host can invite people to this conference' });
    }

    const { data: invitedIds, error: inviteError } = await supabaseAdmin.rpc('invite_group_call_participants', {
      p_room_id: roomId,
      p_actor_user_id: req.user.id,
      p_user_ids: userIds,
    });
    if (inviteError) {
      if (inviteError.code === 'P0001') return res.status(409).json({ error: 'This call has reached its participant limit or is no longer active.' });
      if (inviteError.code === '23505') return res.status(409).json({ error: 'One of the selected people is already in another call or this call.' });
      if (inviteError.code === '42501') return res.status(403).json({ error: 'One or more selected people cannot be invited to this call.' });
      if (inviteError.code === '22023') return res.status(400).json({ error: 'The selected invitees are invalid.' });
      throw inviteError;
    }

    const { data: conversation } = await supabaseAdmin.from('conversations')
      .select('name').eq('id', room.conversation_id).maybeSingle();
    const inviterName = req.user.user_metadata?.name || req.user.user_metadata?.full_name || 'A ZannyChat member';
    const body = room.source_call_id
      ? `${inviterName} invited you to join an ongoing ${room.call_type} call`
      : `${inviterName} invited you to a call in ${conversation?.name || 'your group'}`;
    const deliveries = await Promise.allSettled((invitedIds || userIds).map((userId) => sendPushToUser(userId, {
      title: room.call_type === 'video' ? 'Incoming video call' : 'Incoming voice call',
      body,
      data: { type: 'group_call_invite', groupCallId: roomId, conversationId: room.conversation_id, callType: room.call_type || 'audio' },
    })));
    const pushAccepted = deliveries.filter((result) => result.status === 'fulfilled' && Number(result.value?.sent) > 0).length;
    return res.json({ invited: invitedIds || userIds, invitedCount: (invitedIds || userIds).length, pushAcceptedDevices: pushAccepted });
  } catch (error) {
    console.error('[group-calls] invite failed:', error?.message || error);
    return res.status(503).json({ error: 'Could not invite people to this call' });
  }
});

router.post('/:roomId/leave', async (req, res) => {
  const roomId = req.params.roomId;
  if (!validId(roomId)) return res.status(400).json({ error: 'Invalid group call id' });
  try {
    const { data: roomEnded, error } = await supabaseAdmin.rpc('leave_group_call_room', {
      p_room_id: roomId, p_user_id: req.user.id,
    });
    if (error) throw error;
    return res.json({ left: true, roomEnded: roomEnded === true });
  } catch (error) {
    console.error('[group-calls] leave failed:', error?.message || error);
    return res.status(503).json({ error: 'Could not leave this group call' });
  }
});

router.post('/:roomId/end', async (req, res) => {
  const roomId = req.params.roomId;
  if (!validId(roomId)) return res.status(400).json({ error: 'Invalid group call id' });
  try {
    const { data: room, error: roomError } = await supabaseAdmin.from('group_call_rooms')
      .select('id,source_call_id').eq('id', roomId).maybeSingle();
    if (roomError) throw roomError;
    if (!room) return res.status(404).json({ error: 'Group call is no longer active' });
    const { data: ended, error } = room.source_call_id
      ? await supabaseAdmin.rpc('end_direct_call_room', { p_room_id: roomId, p_user_id: req.user.id })
      : await supabaseAdmin.rpc('end_group_call_room', { p_room_id: roomId, p_user_id: req.user.id });
    if (error) {
      if (error.code === '42501') return res.status(403).json({ error: room.source_call_id
        ? 'Only a connected participant can end this conference'
        : 'Only the call host or a group admin can end this call' });
      throw error;
    }
    if (!ended) return res.status(404).json({ error: 'Group call is no longer active' });

    // Ending the database room alone does not disconnect participants already
    // connected to the SFU. Attempt immediate teardown; the scheduled worker
    // retries any room whose media_terminated_at marker remains unset.
    const mediaCleanup = await cleanupEndedGroupCallMedia({ admin: supabaseAdmin, roomIds: [roomId], limit: 1 });
    return res.json({ ended: true, mediaTerminated: mediaCleanup.terminated > 0, mediaTerminationPending: mediaCleanup.failed > 0 });
  } catch (error) {
    console.error('[group-calls] end failed:', error?.message || error);
    return res.status(503).json({ error: 'Could not end this group call' });
  }
});

module.exports = router;
