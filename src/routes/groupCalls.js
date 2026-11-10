const express = require('express');
const { randomUUID } = require('node:crypto');
const { requireAuth } = require('../middleware/requireAuth');
const { makeLimiter } = require('../middleware/rateLimit');
const { supabaseAdmin } = require('../config/supabaseAdmin');
const { createLiveKitToken, getLiveKitConfig } = require('../services/livekitToken');
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
    const now = new Date().toISOString();
    const { data: room, error: roomError } = await supabaseAdmin.from('group_call_rooms').insert({
      id: roomId,
      conversation_id: conversationId,
      host_user_id: req.user.id,
      room_name: roomName,
      call_type: callType,
      status: 'active',
      max_participants: Math.min(16, eligibleMembers.length),
      started_at: now,
    }).select('id,conversation_id,host_user_id,room_name,call_type,status,max_participants,created_at,started_at').single();
    if (roomError) {
      if (roomError.code === '23505') return res.status(409).json({ error: 'This group already has an active call' });
      throw roomError;
    }
    const participantRows = group.members.map((member) => ({
      room_id: roomId,
      user_id: member.user_id,
      role: member.user_id === req.user.id ? 'host' : 'member',
      status: member.user_id === req.user.id ? 'joined' : blockedIds.has(member.user_id) ? 'declined' : 'invited',
      ...(member.user_id === req.user.id ? { joined_at: now } : {}),
    }));
    const { error: participantError } = await supabaseAdmin.from('group_call_participants').insert(participantRows);
    if (participantError) {
      await supabaseAdmin.from('group_call_rooms').update({ status: 'ended', ended_at: now }).eq('id', roomId);
      throw participantError;
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
      token: tokenFor(req.user, roomName, config),
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
      const status = participant.status === 'declined' ? 'declined'
        : participant.status === 'invited' && room.status === 'ended' ? 'missed'
        : room.status === 'ended' ? 'ended'
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
      .select('id,conversation_id,host_user_id,room_name,status,max_participants')
      .eq('id', roomId).maybeSingle();
    if (roomError) throw roomError;
    if (!room || !['ringing','active'].includes(room.status)) return res.status(404).json({ error: 'Group call is no longer active' });
    const group = await getGroupMembership(room.conversation_id, req.user.id);
    if (group.error) return res.status(group.status).json({ error: group.error });
    const { error: joinError } = await supabaseAdmin.rpc('join_group_call_room', {
      p_room_id: roomId, p_user_id: req.user.id,
    });
    if (joinError) {
      if (joinError.code === 'P0001' && /full/i.test(joinError.message || '')) return res.status(409).json({ error: 'This group call is full' });
      if (joinError.code === '42501') return res.status(403).json({ error: 'You are not a member of this group' });
      if (joinError.code === 'P0001') return res.status(404).json({ error: 'Group call is no longer active' });
      throw joinError;
    }
    return res.json({ room, livekitUrl: config.url, token: tokenFor(req.user, room.room_name, config) });
  } catch (error) {
    console.error('[group-calls] join failed:', error?.message || error);
    return res.status(503).json({ error: 'Could not join this group call' });
  }
});

router.post('/:roomId/leave', async (req, res) => {
  const roomId = req.params.roomId;
  if (!validId(roomId)) return res.status(400).json({ error: 'Invalid group call id' });
  try {
    const now = new Date().toISOString();
    const { error } = await supabaseAdmin.from('group_call_participants').update({
      status: 'left', left_at: now,
    }).eq('room_id', roomId).eq('user_id', req.user.id).eq('status', 'joined');
    if (error) throw error;
    const { data: joined, error: joinedError } = await supabaseAdmin.from('group_call_participants')
      .select('user_id').eq('room_id', roomId).eq('status', 'joined');
    if (joinedError) throw joinedError;
    if (!joined?.length) {
      await supabaseAdmin.from('group_call_rooms')
        .update({ status: 'ended', ended_at: now }).eq('id', roomId).in('status', ['ringing','active']);
      await supabaseAdmin.from('group_call_participants').update({ status: 'left', left_at: now })
        .eq('room_id', roomId).eq('status', 'joined');
    }
    return res.json({ left: true, roomEnded: !joined?.length });
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
      .select('id,conversation_id,host_user_id,status').eq('id', roomId).maybeSingle();
    if (roomError) throw roomError;
    if (!room || !['ringing','active'].includes(room.status)) return res.status(404).json({ error: 'Group call is no longer active' });
    const group = await getGroupMembership(room.conversation_id, req.user.id);
    if (group.error) return res.status(group.status).json({ error: group.error });
    if (room.host_user_id !== req.user.id && !group.membership.is_admin) {
      return res.status(403).json({ error: 'Only the call host or a group admin can end this call' });
    }
    const now = new Date().toISOString();
    const { error: endError } = await supabaseAdmin.from('group_call_rooms').update({
      status: 'ended', ended_at: now,
    }).eq('id', roomId).in('status', ['ringing','active']);
    if (endError) throw endError;
    await supabaseAdmin.from('group_call_participants').update({
      status: 'left', left_at: now,
    }).eq('room_id', roomId).in('status', ['invited','joined']);
    return res.json({ ended: true });
  } catch (error) {
    console.error('[group-calls] end failed:', error?.message || error);
    return res.status(503).json({ error: 'Could not end this group call' });
  }
});

module.exports = router;
