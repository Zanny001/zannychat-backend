const express = require('express');
const crypto = require('node:crypto');
const { requireAuth } = require('../middleware/requireAuth');
const { conversationsLimiter } = require('../middleware/rateLimit');
const { supabaseAdmin } = require('../config/supabaseAdmin');
const { validateDirectParticipantId, validateGroupInput } = require('../utils/conversationValidation');

const router = express.Router();

// Auth first (so the limiter keys on the user id, not the IP), then
// the throttle — every route in this router requires both.
router.use(requireAuth, conversationsLimiter);

// Creates a conversation and both participant rows together. The
// frontend's NewChatScreen currently fakes a local conversation id when
// you tap a contact — point it at this endpoint to make that real.
//
//   POST /conversations   { "participantId": "<uuid>" }
router.post('/', async (req, res) => {
  if (!supabaseAdmin) return res.status(500).json({ error: 'Backend is not configured' });

  const perfStart = Date.now();
  let perfLast = perfStart;
  const perfLog = (step) => {
    const now = Date.now();
    console.log('[Perf][Conversations]', {
      step,
      stepMs: now - perfLast,
      totalMs: now - perfStart,
    });
    perfLast = now;
  };

  const { participantId } = req.body || {};
  if (!participantId) {
    return res.status(400).json({ error: 'participantId is required' });
  }
  const participantValidation = validateDirectParticipantId(participantId, req.user.id);
  if (!participantValidation.ok) {
    return res.status(400).json({ error: participantValidation.error });
  }

  // A block in EITHER direction prevents a new 1:1 — being blocked
  // means the other person never sees your message anyway (RLS rejects
  // the insert), so letting the conversation get created would just be
  // a confusing dead end for the sender.
  const { data: blockRows, error: blockError } = await supabaseAdmin
    .from('blocked_users')
    .select('blocker_id, blocked_id')
    .or(
      `and(blocker_id.eq.${req.user.id},blocked_id.eq.${participantId}),` +
        `and(blocker_id.eq.${participantId},blocked_id.eq.${req.user.id})`
    )
    .limit(1);
  perfLog('block_check');

  if (blockError) return res.status(500).json({ error: 'Unable to check conversation permissions' });
  if (blockRows && blockRows.length > 0) {
    return res.status(403).json({ error: 'Cannot start a conversation with this user' });
  }

  // Reuse an existing direct conversation shared by these two users.
  // This avoids splitting new messages across duplicate conversation IDs.
  const { data: membershipRows, error: membershipError } = await supabaseAdmin
    .from('conversation_participants')
    .select('conversation_id, user_id')
    .in('user_id', [req.user.id, participantId]);
  perfLog('membership_lookup');

  if (membershipError) {
    return res.status(500).json({ error: 'Unable to check existing conversations' });
  }

  const membersByConversation = new Map();
  for (const row of membershipRows || []) {
    if (!membersByConversation.has(row.conversation_id)) {
      membersByConversation.set(row.conversation_id, new Set());
    }
    membersByConversation.get(row.conversation_id).add(row.user_id);
  }

  const sharedIds = [...membersByConversation.entries()]
    .filter(([, users]) => users.has(req.user.id) && users.has(participantId))
    .map(([id]) => id);

  if (sharedIds.length > 0) {
    const { data: existingConversation, error: existingError } = await supabaseAdmin
      .from('conversations')
      .select('*')
      .in('id', sharedIds)
      .eq('is_group', false)
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle();
    perfLog('existing_conversation_lookup');

    if (existingError) {
      return res.status(500).json({ error: 'Unable to load existing conversation' });
    }

    if (existingConversation) {
      return res.status(200).json(existingConversation);
    }
  }

  const { data: conversation, error: convError } = await supabaseAdmin
    .from('conversations')
    .insert({})
    .select()
    .single();
  perfLog('conversation_insert');

  if (convError) return res.status(500).json({ error: 'Unable to create conversation' });

  const { error: participantsError } = await supabaseAdmin.from('conversation_participants').insert([
    { conversation_id: conversation.id, user_id: req.user.id },
    { conversation_id: conversation.id, user_id: participantId },
  ]);
  perfLog('participant_insert');

  if (participantsError) {
    // Roll back the orphaned conversation row rather than leaving a
    // conversation with no participants behind.
    await supabaseAdmin.from('conversations').delete().eq('id', conversation.id);
    return res.status(500).json({ error: 'Unable to add conversation participants' });
  }

  res.status(201).json(conversation);
});

// Separate from POST / (above) rather than overloading it — a group
// needs a name and 2+ other participants, a 1:1 needs neither, and
// keeping them as different request shapes on different routes means
// neither has to guess which case it's in.
//
//   POST /conversations/group   { "participantIds": ["<uuid>", ...], "name": "Trip planning" }
router.post('/group', async (req, res) => {
  if (!supabaseAdmin) return res.status(500).json({ error: 'Backend is not configured' });

  const { participantIds, name } = req.body || {};
  const validation = validateGroupInput(participantIds, name, req.user.id);
  if (!validation.ok) {
    return res.status(400).json({ error: validation.error });
  }
  const uniqueOtherIds = validation.participantIds;

  const { data: conversation, error: convError } = await supabaseAdmin
    .from('conversations')
    .insert({ name: validation.name, is_group: true })
    .select()
    .single();

  if (convError) return res.status(500).json({ error: 'Unable to create conversation' });

  const rows = [
    { conversation_id: conversation.id, user_id: req.user.id, is_admin: true },
    ...uniqueOtherIds.map((userId) => ({ conversation_id: conversation.id, user_id: userId, is_admin: false })),
  ];

  const { error: participantsError } = await supabaseAdmin.from('conversation_participants').insert(rows);

  if (participantsError) {
    await supabaseAdmin.from('conversations').delete().eq('id', conversation.id);
    return res.status(500).json({ error: 'Unable to add conversation participants' });
  }

  res.status(201).json(conversation);
});


// Create a bounded-use, expiring group invite. The raw token is returned once;
// only its SHA-256 hash is stored in the database.
router.post('/:conversationId/invites', async (req, res) => {
  if (!supabaseAdmin) return res.status(500).json({ error: 'Backend is not configured' });
  const { conversationId } = req.params;
  const expiresInHours = req.body?.expiresInHours ?? 168;
  const maxUses = req.body?.maxUses ?? 25;
  if (!Number.isInteger(expiresInHours) || expiresInHours < 1 || expiresInHours > 168) {
    return res.status(400).json({ error: 'expiresInHours must be an integer from 1 to 168' });
  }
  if (!Number.isInteger(maxUses) || maxUses < 1 || maxUses > 100) {
    return res.status(400).json({ error: 'maxUses must be an integer from 1 to 100' });
  }
  const { data: conversation, error: conversationError } = await supabaseAdmin.from('conversations')
    .select('id,is_group').eq('id', conversationId).maybeSingle();
  if (conversationError) return res.status(500).json({ error: 'Unable to check group' });
  if (!conversation || !conversation.is_group) return res.status(404).json({ error: 'Group not found' });
  const { data: actor, error: actorError } = await supabaseAdmin.from('conversation_participants')
    .select('is_admin').eq('conversation_id', conversationId).eq('user_id', req.user.id).maybeSingle();
  if (actorError) return res.status(500).json({ error: 'Unable to check group permissions' });
  if (!actor?.is_admin) return res.status(403).json({ error: 'Only group admins can create invites' });
  const token = crypto.randomBytes(32).toString('base64url');
  const tokenHash = crypto.createHash('sha256').update(token).digest('hex');
  const expiresAt = new Date(Date.now() + expiresInHours * 60 * 60 * 1000).toISOString();
  const { data: invite, error: insertError } = await supabaseAdmin.from('group_invites').insert({
    conversation_id: conversationId, token_hash: tokenHash, created_by: req.user.id, expires_at: expiresAt, max_uses: maxUses,
  }).select('id,expires_at,max_uses').single();
  if (insertError) return res.status(500).json({ error: 'Unable to create group invite' });
  return res.status(201).json({ id: invite.id, token, expiresAt: invite.expires_at, maxUses: invite.max_uses, inviteLink: `zannychat://join-group?token=${encodeURIComponent(token)}` });
});

router.post('/invites/accept', async (req, res) => {
  if (!supabaseAdmin) return res.status(500).json({ error: 'Backend is not configured' });
  const token = typeof req.body?.token === 'string' ? req.body.token.trim() : '';
  if (token.length < 30 || token.length > 200 || !/^[A-Za-z0-9_-]+$/.test(token)) {
    return res.status(400).json({ error: 'Enter a valid group invite token' });
  }
  const tokenHash = crypto.createHash('sha256').update(token).digest('hex');
  const { data: conversationId, error } = await supabaseAdmin.rpc('accept_group_invite', {
    p_token_hash: tokenHash, p_user_id: req.user.id,
  });
  if (error) {
    const unavailable = /invite_unavailable|group_unavailable|invalid_invite/i.test(error.message || '');
    return res.status(unavailable ? 410 : 500).json({ error: unavailable ? 'This invite is expired, revoked, or has reached its use limit.' : 'Unable to accept group invite' });
  }
  return res.json({ conversationId, joined: true });
});

router.get('/:conversationId/invites', async (req, res) => {
  if (!supabaseAdmin) return res.status(500).json({ error: 'Backend is not configured' });
  const { conversationId } = req.params;
  const { data: actor, error: actorError } = await supabaseAdmin.from('conversation_participants')
    .select('is_admin').eq('conversation_id', conversationId).eq('user_id', req.user.id).maybeSingle();
  if (actorError) return res.status(500).json({ error: 'Unable to check group permissions' });
  if (!actor?.is_admin) return res.status(403).json({ error: 'Only group admins can view invites' });
  const { data, error } = await supabaseAdmin.from('group_invites')
    .select('id,created_at,expires_at,max_uses,use_count,revoked_at')
    .eq('conversation_id', conversationId).order('created_at', { ascending: false }).limit(50);
  if (error) return res.status(500).json({ error: 'Unable to load group invites' });
  const now = Date.now();
  return res.json({ invites: (data || []).map((invite) => ({
    id: invite.id, createdAt: invite.created_at, expiresAt: invite.expires_at,
    maxUses: invite.max_uses, useCount: invite.use_count, revokedAt: invite.revoked_at,
    status: invite.revoked_at ? 'revoked' : (new Date(invite.expires_at).getTime() <= now ? 'expired' : (invite.use_count >= invite.max_uses ? 'used_up' : 'active')),
  })) });
});

router.delete('/:conversationId/invites/:inviteId', async (req, res) => {
  if (!supabaseAdmin) return res.status(500).json({ error: 'Backend is not configured' });
  const { conversationId, inviteId } = req.params;
  const { data: actor, error: actorError } = await supabaseAdmin.from('conversation_participants')
    .select('is_admin').eq('conversation_id', conversationId).eq('user_id', req.user.id).maybeSingle();
  if (actorError) return res.status(500).json({ error: 'Unable to check group permissions' });
  if (!actor?.is_admin) return res.status(403).json({ error: 'Only group admins can revoke invites' });
  const { data: invite, error: inviteError } = await supabaseAdmin.from('group_invites')
    .select('id').eq('id', inviteId).eq('conversation_id', conversationId).is('revoked_at', null).maybeSingle();
  if (inviteError) return res.status(500).json({ error: 'Unable to check invite' });
  if (!invite) return res.status(404).json({ error: 'Active invite not found' });
  const { error: updateError } = await supabaseAdmin.from('group_invites').update({ revoked_at: new Date().toISOString() }).eq('id', inviteId);
  if (updateError) return res.status(500).json({ error: 'Unable to revoke invite' });
  return res.status(204).end();
});

// Group metadata is editable by admins only. Text is bounded at the API
// boundary and the membership/admin check is independent of client UI state.
router.get('/:conversationId/metadata', async (req, res) => {
  if (!supabaseAdmin) return res.status(500).json({ error: 'Backend is not configured' });
  const { conversationId } = req.params;
  const { data: membership, error: membershipError } = await supabaseAdmin
    .from('conversation_participants').select('is_admin')
    .eq('conversation_id', conversationId).eq('user_id', req.user.id).maybeSingle();
  if (membershipError) return res.status(500).json({ error: 'Unable to check group membership' });
  if (!membership) return res.status(403).json({ error: 'You are not a group member' });
  const { data, error } = await supabaseAdmin.from('conversations')
    .select('id,name,group_topic,group_description,admin_only_messages,is_group').eq('id', conversationId).maybeSingle();
  if (error) return res.status(500).json({ error: 'Unable to load group metadata' });
  if (!data || !data.is_group) return res.status(404).json({ error: 'Group not found' });
  return res.json({ conversationId, name: data.name || '', topic: data.group_topic || '', description: data.group_description || '', adminOnlyMessages: Boolean(data.admin_only_messages), canEdit: Boolean(membership.is_admin) });
});

router.patch('/:conversationId/metadata', async (req, res) => {
  if (!supabaseAdmin) return res.status(500).json({ error: 'Backend is not configured' });
  const { conversationId } = req.params;
  const topic = typeof req.body?.topic === 'string' ? req.body.topic.trim() : null;
  const description = typeof req.body?.description === 'string' ? req.body.description.trim() : null;
  const name = req.body?.name === undefined ? undefined : (typeof req.body.name === 'string' ? req.body.name.trim() : null);
  if (topic === null || description === null) return res.status(400).json({ error: 'topic and description must be strings' });
  if (name === null || (name !== undefined && (!name || name.length > 80))) return res.status(400).json({ error: 'Group name must be between 1 and 80 characters' });
  if (topic.length > 80) return res.status(400).json({ error: 'Topic must be 80 characters or fewer' });
  const adminOnlyMessages = req.body?.adminOnlyMessages;
  if (adminOnlyMessages !== undefined && typeof adminOnlyMessages !== 'boolean') return res.status(400).json({ error: 'adminOnlyMessages must be a boolean' });
  if (description.length > 500) return res.status(400).json({ error: 'Description must be 500 characters or fewer' });
  const { data: conversation, error: conversationError } = await supabaseAdmin.from('conversations')
    .select('id,is_group').eq('id', conversationId).maybeSingle();
  if (conversationError) return res.status(500).json({ error: 'Unable to check group' });
  if (!conversation || !conversation.is_group) return res.status(404).json({ error: 'Group not found' });
  const { data: actor, error: actorError } = await supabaseAdmin.from('conversation_participants')
    .select('is_admin').eq('conversation_id', conversationId).eq('user_id', req.user.id).maybeSingle();
  if (actorError) return res.status(500).json({ error: 'Unable to check group permissions' });
  if (!actor) return res.status(403).json({ error: 'You are not a group member' });
  if (!actor.is_admin) return res.status(403).json({ error: 'Only group admins can edit group metadata' });
  const changes = { group_topic: topic, group_description: description };
  if (name !== undefined) changes.name = name;
  if (adminOnlyMessages !== undefined) changes.admin_only_messages = adminOnlyMessages;
  const { data, error } = await supabaseAdmin.from('conversations')
    .update(changes).eq('id', conversationId)
    .select('id,name,group_topic,group_description,admin_only_messages').single();
  if (error) return res.status(500).json({ error: 'Unable to update group metadata' });
  return res.json({ conversationId: data.id, name: data.name || '', topic: data.group_topic || '', description: data.group_description || '', adminOnlyMessages: Boolean(data.admin_only_messages), canEdit: true });
});

// Return the authenticated member's group roster. The route verifies membership
// before using the service-role client, so non-members cannot enumerate profiles.
router.get('/:conversationId/members', async (req, res) => {
  if (!supabaseAdmin) return res.status(500).json({ error: 'Backend is not configured' });
  const { conversationId } = req.params;
  const { data: conversation, error: conversationError } = await supabaseAdmin
    .from('conversations').select('id,is_group,name').eq('id', conversationId).maybeSingle();
  if (conversationError) return res.status(500).json({ error: 'Unable to check conversation' });
  if (!conversation || !conversation.is_group) return res.status(404).json({ error: 'Group not found' });
  const { data: actor, error: actorError } = await supabaseAdmin.from('conversation_participants')
    .select('user_id').eq('conversation_id', conversationId).eq('user_id', req.user.id).maybeSingle();
  if (actorError) return res.status(500).json({ error: 'Unable to check group membership' });
  if (!actor) return res.status(403).json({ error: 'You are not a group member' });
  const { data: rows, error: rowsError } = await supabaseAdmin.from('conversation_participants')
    .select('user_id,is_admin,joined_at,profiles(id,name,avatar_url)')
    .eq('conversation_id', conversationId).order('joined_at', { ascending: true });
  if (rowsError) return res.status(500).json({ error: 'Unable to load group members' });
  return res.json({ conversationId, name: conversation.name, members: (rows || []).map((row) => ({
    id: row.user_id, isAdmin: Boolean(row.is_admin), joinedAt: row.joined_at || null,
    profile: row.profiles ? { id: row.profiles.id, name: row.profiles.name || 'ZannyChat member', avatarUrl: row.profiles.avatar_url || null } : { id: row.user_id, name: 'ZannyChat member', avatarUrl: null },
  })) });
});

// Group membership administration. All writes use the verified user from
// requireAuth and the server-side service client; client-supplied actor IDs
// are never accepted. Only existing group admins can manage other members.
router.patch('/:conversationId/members/:memberId/admin', async (req, res) => {
  if (!supabaseAdmin) return res.status(500).json({ error: 'Backend is not configured' });
  const { conversationId, memberId } = req.params;
  const { isAdmin } = req.body || {};
  if (typeof isAdmin !== 'boolean') return res.status(400).json({ error: 'isAdmin must be a boolean' });
  if (memberId === req.user.id && isAdmin === false) {
    return res.status(400).json({ error: 'You cannot remove your own admin role here' });
  }

  const { data: conversation, error: conversationError } = await supabaseAdmin
    .from('conversations').select('id,is_group').eq('id', conversationId).maybeSingle();
  if (conversationError) return res.status(500).json({ error: 'Unable to check conversation' });
  if (!conversation || !conversation.is_group) return res.status(404).json({ error: 'Group not found' });

  const { data: actor, error: actorError } = await supabaseAdmin
    .from('conversation_participants').select('is_admin').eq('conversation_id', conversationId).eq('user_id', req.user.id).maybeSingle();
  if (actorError) return res.status(500).json({ error: 'Unable to check group permissions' });
  if (!actor) return res.status(403).json({ error: 'You are not a group member' });
  if (!actor.is_admin) return res.status(403).json({ error: 'Only group admins can manage members' });

  const { data: target, error: targetError } = await supabaseAdmin
    .from('conversation_participants').select('user_id').eq('conversation_id', conversationId).eq('user_id', memberId).maybeSingle();
  if (targetError) return res.status(500).json({ error: 'Unable to check target member' });
  if (!target) return res.status(404).json({ error: 'Group member not found' });

  const { error: updateError } = await supabaseAdmin.from('conversation_participants')
    .update({ is_admin: isAdmin }).eq('conversation_id', conversationId).eq('user_id', memberId);
  if (updateError) return res.status(500).json({ error: 'Unable to update group role' });
  return res.json({ conversationId, memberId, isAdmin });
});

router.delete('/:conversationId/members/:memberId', async (req, res) => {
  if (!supabaseAdmin) return res.status(500).json({ error: 'Backend is not configured' });
  const { conversationId, memberId } = req.params;
  const { data: conversation, error: conversationError } = await supabaseAdmin
    .from('conversations').select('id,is_group').eq('id', conversationId).maybeSingle();
  if (conversationError) return res.status(500).json({ error: 'Unable to check conversation' });
  if (!conversation || !conversation.is_group) return res.status(404).json({ error: 'Group not found' });

  const { data: actor, error: actorError } = await supabaseAdmin
    .from('conversation_participants').select('is_admin').eq('conversation_id', conversationId).eq('user_id', req.user.id).maybeSingle();
  if (actorError) return res.status(500).json({ error: 'Unable to check group permissions' });
  if (!actor) return res.status(403).json({ error: 'You are not a group member' });
  if (memberId !== req.user.id && !actor.is_admin) return res.status(403).json({ error: 'Only group admins can remove other members' });

  if (memberId === req.user.id && actor.is_admin) {
    const { count, error: countError } = await supabaseAdmin.from('conversation_participants')
      .select('user_id', { count: 'exact', head: true }).eq('conversation_id', conversationId).eq('is_admin', true);
    if (countError) return res.status(500).json({ error: 'Unable to check group admins' });
    if ((count || 0) <= 1) return res.status(409).json({ error: 'Promote another admin before leaving the group' });
  }

  const { error: deleteError } = await supabaseAdmin.from('conversation_participants')
    .delete().eq('conversation_id', conversationId).eq('user_id', memberId);
  if (deleteError) return res.status(500).json({ error: 'Unable to remove group member' });
  return res.status(204).end();
});


// Scheduled messages are stored server-side so they survive client disconnects.
// Delivery is performed by the dedicated scheduled-message worker after migration 0043.
router.get('/scheduled-messages', async (req, res) => {
  if (!supabaseAdmin) return res.status(500).json({ error: 'Backend is not configured' });
  const { data, error } = await supabaseAdmin.from('scheduled_messages')
    .select('id, conversation_id, text, scheduled_for, status, created_at')
    .eq('sender_id', req.user.id).eq('status', 'pending')
    .order('scheduled_for', { ascending: true }).limit(100);
  if (error) return res.status(500).json({ error: 'Unable to load scheduled messages' });
  return res.json({ scheduledMessages: data || [] });
});

router.post('/scheduled-messages', async (req, res) => {
  if (!supabaseAdmin) return res.status(500).json({ error: 'Backend is not configured' });
  const conversationId = typeof req.body?.conversationId === 'string' ? req.body.conversationId.trim() : '';
  const messageText = typeof req.body?.text === 'string' ? req.body.text.trim() : '';
  const scheduledFor = typeof req.body?.scheduledFor === 'string' ? Date.parse(req.body.scheduledFor) : NaN;
  const now = Date.now();
  if (!conversationId || conversationId.length > 100) return res.status(400).json({ error: 'A valid conversationId is required' });
  if (!messageText || messageText.length > 4000) return res.status(400).json({ error: 'Message text must be 1–4000 characters' });
  if (!Number.isFinite(scheduledFor) || scheduledFor < now + 60_000 || scheduledFor > now + 30 * 24 * 60 * 60 * 1000) {
    return res.status(400).json({ error: 'scheduledFor must be between 1 minute and 30 days from now' });
  }
  const { data: membership, error: membershipError } = await supabaseAdmin.from('conversation_participants')
    .select('conversation_id').eq('conversation_id', conversationId).eq('user_id', req.user.id).maybeSingle();
  if (membershipError) return res.status(500).json({ error: 'Unable to check conversation permissions' });
  if (!membership) return res.status(404).json({ error: 'Conversation not found' });
  const { data, error } = await supabaseAdmin.from('scheduled_messages').insert({
    conversation_id: conversationId,
    sender_id: req.user.id,
    text: messageText,
    scheduled_for: new Date(scheduledFor).toISOString(),
  }).select('id, conversation_id, text, scheduled_for, status, created_at').single();
  if (error) return res.status(500).json({ error: 'Unable to schedule message' });
  return res.status(201).json({ scheduledMessage: data });
});

router.delete('/scheduled-messages/:scheduledMessageId', async (req, res) => {
  if (!supabaseAdmin) return res.status(500).json({ error: 'Backend is not configured' });
  const { data, error } = await supabaseAdmin.from('scheduled_messages').update({ status: 'cancelled', updated_at: new Date().toISOString() })
    .eq('id', req.params.scheduledMessageId).eq('sender_id', req.user.id).eq('status', 'pending')
    .select('id').maybeSingle();
  if (error) return res.status(500).json({ error: 'Unable to cancel scheduled message' });
  if (!data) return res.status(404).json({ error: 'Pending scheduled message not found' });
  return res.status(204).end();
});

module.exports = router;
