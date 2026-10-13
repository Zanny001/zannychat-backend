const express = require('express');
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

  if (blockError) return res.status(500).json({ error: blockError.message });
  if (blockRows && blockRows.length > 0) {
    return res.status(403).json({ error: 'Cannot start a conversation with this user' });
  }

  const { data: conversation, error: convError } = await supabaseAdmin
    .from('conversations')
    .insert({})
    .select()
    .single();

  if (convError) return res.status(500).json({ error: convError.message });

  const { error: participantsError } = await supabaseAdmin.from('conversation_participants').insert([
    { conversation_id: conversation.id, user_id: req.user.id },
    { conversation_id: conversation.id, user_id: participantId },
  ]);

  if (participantsError) {
    // Roll back the orphaned conversation row rather than leaving a
    // conversation with no participants behind.
    await supabaseAdmin.from('conversations').delete().eq('id', conversation.id);
    return res.status(500).json({ error: participantsError.message });
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

  if (convError) return res.status(500).json({ error: convError.message });

  const rows = [req.user.id, ...uniqueOtherIds].map((userId) => ({
    conversation_id: conversation.id,
    user_id: userId,
  }));

  const { error: participantsError } = await supabaseAdmin.from('conversation_participants').insert(rows);

  if (participantsError) {
    await supabaseAdmin.from('conversations').delete().eq('id', conversation.id);
    return res.status(500).json({ error: participantsError.message });
  }

  res.status(201).json(conversation);
});

module.exports = router;
