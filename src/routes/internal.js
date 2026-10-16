const express = require('express');
const crypto = require('crypto');
const { supabaseAdmin } = require('../config/supabaseAdmin');
const { sendPushToUser } = require('../config/pushClient');

const router = express.Router();

// Not user-facing — this is called by the pg_net trigger in
// 0003_groups_voice_push.sql on every message insert, authenticated by
// a shared secret rather than a user session (there's no user request
// here, just Postgres). See that migration's bottom comment for the
// required ALTER DATABASE step this depends on.
// Constant-time comparison rather than !== — the audit flagged the
// plain string compare as a (low-risk, but free-to-fix) timing side
// channel. timingSafeEqual throws on unequal lengths, so that's
// checked first; length leaking is fine, it's not the secret.
function secretsEqual(provided, expected) {
  const a = Buffer.from(String(provided));
  const b = Buffer.from(String(expected));
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function requireInternalSecret(req, res, next) {
  const expected = process.env.INTERNAL_WEBHOOK_SECRET;
  const provided = (req.headers.authorization || '').replace('Bearer ', '');

  if (!expected) {
    console.warn('[webhooks/new-message] INTERNAL_WEBHOOK_SECRET is not set — rejecting.');
    return res.status(501).json({ error: 'Push notifications are not configured on this backend yet' });
  }
  if (!secretsEqual(provided, expected)) {
    return res.status(401).json({ error: 'Invalid internal secret' });
  }
  next();
}

function previewFor(text, mediaType) {
  if (text) return text;
  if (mediaType === 'image') return '📷 Photo';
  if (mediaType === 'file') return '📄 File';
  if (mediaType === 'voice') return '🎤 Voice message';
  if (mediaType === 'contact') return '👤 Contact';
  return 'New message';
}

router.post('/new-message', requireInternalSecret, async (req, res) => {
  const { conversationId, senderId, text, mediaType } = req.body || {};
  if (!conversationId || !senderId) {
    return res.status(400).json({ error: 'conversationId and senderId are required' });
  }

  try {
    const [{ data: conversation }, { data: participants }, { data: sender }] = await Promise.all([
      supabaseAdmin.from('conversations').select('name, is_group').eq('id', conversationId).single(),
      supabaseAdmin.from('conversation_participants').select('user_id, is_muted').eq('conversation_id', conversationId),
      supabaseAdmin.from('profiles').select('name').eq('id', senderId).single(),
    ]);

    // Two recipient-side filters beyond "not the sender", both added
    // with 0006:
    //   * is_muted — muting a conversation means no lock-screen pings
    //     from it, not just a quiet badge in the list.
    //   * blocked — someone who blocked the sender should never get a
    //     push for their message. The message itself is already
    //     rejected by RLS in a 1:1; in a group the message exists but
    //     the notification still doesn't reach the blocker.
    const candidateRecipients = (participants || [])
      .filter((p) => p.user_id !== senderId && !p.is_muted)
      .map((p) => p.user_id);

    let recipients = candidateRecipients;
    if (candidateRecipients.length > 0) {
      const { data: blocks } = await supabaseAdmin
        .from('blocked_users')
        .select('blocker_id')
        .eq('blocked_id', senderId)
        .in('blocker_id', candidateRecipients);
      const blockerIds = new Set((blocks || []).map((b) => b.blocker_id));
      recipients = candidateRecipients.filter((id) => !blockerIds.has(id));
    }
    const title = conversation?.is_group ? `${conversation.name || 'Group'} · ${sender?.name || 'Someone'}` : sender?.name || 'New message';
    const body = previewFor(text, mediaType);

    const results = await Promise.allSettled(
      recipients.map((userId) =>
        sendPushToUser(userId, {
          title,
          body,
          data: { conversationId },
        })
      )
    );

    const sent = results.filter((r) => r.status === 'fulfilled').reduce((sum, r) => sum + (r.value?.sent || 0), 0);
    res.json({ recipients: recipients.length, sent });
  } catch (err) {
    // Errors here should never surface to whoever sent the message —
    // this endpoint exists purely as a side effect of that insert, not
    // something the sender is waiting on.
    console.error('[webhooks/new-message] failed:', err.message);
    res.status(500).json({ error: 'Unable to process message notification' });
  }
});

module.exports = router;
