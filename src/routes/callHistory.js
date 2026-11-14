const express = require('express');
const { requireAuth } = require('../middleware/requireAuth');
const { makeLimiter } = require('../middleware/rateLimit');
const { supabaseAdmin } = require('../config/supabaseAdmin');

const router = express.Router();
router.use(requireAuth, makeLimiter({ windowMs: 60 * 1000, max: 20, error: 'Call history actions are rate-limited.' }));

function validId(value) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(String(value || ''));
}

router.get('/hidden', async (req, res) => {
  try {
    const { data, error } = await supabaseAdmin.from('call_history_hidden')
      .select('call_id,call_kind').eq('user_id', req.user.id).order('created_at', { ascending: false }).limit(500);
    if (error) throw error;
    const rows = data || [];
    return res.json({
      hiddenCallIds: rows.filter((row) => row.call_kind === 'direct').map((row) => row.call_id),
      hiddenGroupCallIds: rows.filter((row) => row.call_kind === 'group').map((row) => row.call_id),
    });
  } catch (error) {
    console.error('[calls] hidden history lookup failed:', error.message || error);
    return res.status(503).json({ error: 'Could not load call history preferences' });
  }
});

router.delete('/:kind/:callId', async (req, res) => {
  const { kind, callId } = req.params;
  if (!['direct', 'group'].includes(kind) || !validId(callId)) {
    return res.status(400).json({ error: 'Invalid call history record' });
  }
  try {
    let participant = false;
    if (kind === 'direct') {
      const { data, error } = await supabaseAdmin.from('call_sessions')
        .select('id,caller_id,callee_id').eq('id', callId).maybeSingle();
      if (error) throw error;
      participant = Boolean(data && [data.caller_id, data.callee_id].includes(req.user.id));
    } else {
      const { data, error } = await supabaseAdmin.from('group_call_participants')
        .select('room_id').eq('room_id', callId).eq('user_id', req.user.id).maybeSingle();
      if (error) throw error;
      participant = Boolean(data);
    }
    if (!participant) return res.status(404).json({ error: 'Call history record not found' });
    const { error: insertError } = await supabaseAdmin.from('call_history_hidden').upsert({
      user_id: req.user.id, call_id: callId, call_kind: kind,
    }, { onConflict: 'user_id,call_id,call_kind', ignoreDuplicates: true });
    if (insertError) throw insertError;
    return res.json({ hidden: true, callId, kind });
  } catch (error) {
    console.error('[calls] hide history record failed:', error.message || error);
    return res.status(503).json({ error: 'Could not delete this call history record' });
  }
});

module.exports = router;
