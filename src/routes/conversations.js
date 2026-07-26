const express = require('express');
const { requireAuth } = require('../middleware/requireAuth');
const { supabaseAdmin } = require('../config/supabaseAdmin');

const router = express.Router();

// Creates a conversation and both participant rows together. The
// frontend's NewChatScreen currently fakes a local conversation id when
// you tap a contact — point it at this endpoint to make that real.
//
//   POST /conversations   { "participantId": "<uuid>" }
router.post('/', requireAuth, async (req, res) => {
  if (!supabaseAdmin) return res.status(500).json({ error: 'Backend is not configured' });

  const { participantId } = req.body || {};
  if (!participantId) {
    return res.status(400).json({ error: 'participantId is required' });
  }
  if (participantId === req.user.id) {
    return res.status(400).json({ error: 'Cannot start a conversation with yourself' });
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

module.exports = router;
