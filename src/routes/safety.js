const express = require('express');
const { requireAuth } = require('../middleware/requireAuth');
const { safetyLimiter } = require('../middleware/rateLimit');
const { supabaseAdmin } = require('../config/supabaseAdmin');
const { isUuid } = require('../utils/safetyValidation');

const router = express.Router();

// Trust & safety endpoints, added after the Oct 2026 audit found zero
// abuse resistance in the app: no block, no report, nothing. The
// tables + RLS live in supabase/migrations/0006_safety_reactions_and_hardening.sql
// — these routes use the service-role client (which bypasses RLS), so
// every handler below enforces "you only ever act as yourself"
// explicitly via req.user.id, the same discipline the AI routes use
// with assertParticipant.
//
// What a block means, enforced in three places:
//   1. POST /conversations refuses to create a 1:1 between two users
//      where either has blocked the other (see conversations.js).
//   2. The messages INSERT RLS policy rejects a send into any
//      conversation where another participant has blocked the sender
//      (0006, via the is_blocked_in_conversation security-definer fn).
//   3. The push webhook skips recipients who blocked the sender, so a
//      blocked message also can't reach someone's lock screen
//      (internal.js).

router.use(requireAuth, safetyLimiter);

function requireConfigured(res) {
  if (!supabaseAdmin) {
    res.status(500).json({ error: 'Backend is not configured' });
    return false;
  }
  return true;
}

// POST /safety/block { "userId": "<uuid>" }
router.post('/block', async (req, res) => {
  if (!requireConfigured(res)) return;

  const { userId } = req.body || {};
  if (!userId) return res.status(400).json({ error: 'userId is required' });
  if (!isUuid(userId)) return res.status(400).json({ error: 'userId must be a valid UUID' });
  if (userId === req.user.id) return res.status(400).json({ error: 'You cannot block yourself' });

  // Upsert-shaped: blocking someone twice is a no-op, not an error —
  // the client shouldn't have to track whether it already blocked.
  const { error } = await supabaseAdmin
    .from('blocked_users')
    .upsert({ blocker_id: req.user.id, blocked_id: userId }, { onConflict: 'blocker_id,blocked_id' });

  if (error) return res.status(500).json({ error: error.message });
  res.status(201).json({ blocked: true });
});

// POST /safety/unblock { "userId": "<uuid>" }
router.post('/unblock', async (req, res) => {
  if (!requireConfigured(res)) return;

  const { userId } = req.body || {};
  if (!userId) return res.status(400).json({ error: 'userId is required' });
  if (!isUuid(userId)) return res.status(400).json({ error: 'userId must be a valid UUID' });

  const { error } = await supabaseAdmin
    .from('blocked_users')
    .delete()
    .eq('blocker_id', req.user.id)
    .eq('blocked_id', userId);

  if (error) return res.status(500).json({ error: error.message });
  res.json({ blocked: false });
});

// GET /safety/blocked — the current user's own block list, with the
// blocked profiles joined so the Privacy screen can render names and
// avatars without a second round trip.
router.get('/blocked', async (req, res) => {
  if (!requireConfigured(res)) return;

  const { data, error } = await supabaseAdmin
    .from('blocked_users')
    .select('blocked_id, created_at, profiles:blocked_id(id, name, avatar_color, avatar_url)')
    .eq('blocker_id', req.user.id)
    .order('created_at', { ascending: false });

  if (error) return res.status(500).json({ error: error.message });
  res.json({
    blocked: (data || []).map((row) => ({
      userId: row.blocked_id,
      since: row.created_at,
      profile: row.profiles,
    })),
  });
});

// POST /safety/report { "reportedUserId": "<uuid>", "messageId"?: "<uuid>", "reason"?: "..." }
// Stored for review — there is no automated moderation pipeline behind
// this yet (that's a real roadmap item, not a stub this endpoint
// pretends to call), so the response is honest about "received", not
// "actioned".
router.post('/report', async (req, res) => {
  if (!requireConfigured(res)) return;

  const { reportedUserId, messageId, reason } = req.body || {};
  if (!reportedUserId) return res.status(400).json({ error: 'reportedUserId is required' });
  if (!isUuid(reportedUserId)) return res.status(400).json({ error: 'reportedUserId must be a valid UUID' });
  if (messageId != null && !isUuid(messageId)) return res.status(400).json({ error: 'messageId must be a valid UUID' });
  if (reportedUserId === req.user.id) return res.status(400).json({ error: 'You cannot report yourself' });
  if (reason && typeof reason === 'string' && reason.length > 1000) {
    return res.status(400).json({ error: 'reason is limited to 1000 characters' });
  }

  const { error } = await supabaseAdmin.from('reports').insert({
    reporter_id: req.user.id,
    reported_user_id: reportedUserId,
    message_id: messageId || null,
    reason: typeof reason === 'string' ? reason : '',
  });

  if (error) return res.status(500).json({ error: error.message });
  res.status(201).json({ received: true });
});

module.exports = router;
