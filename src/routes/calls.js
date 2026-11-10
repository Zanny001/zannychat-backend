const express = require('express');
const { requireAuth } = require('../middleware/requireAuth');
const { makeLimiter } = require('../middleware/rateLimit');
const { buildIceConfig } = require('../utils/turnCredentials.cjs');
const { runCallInvitationNotifications } = require('../jobs/callInvitationNotifications');
const { supabaseAdmin } = require('../config/supabaseAdmin');

const router = express.Router();
router.use(requireAuth, makeLimiter({ windowMs: 60 * 1000, max: 12, error: 'Call setup is rate-limited. Please wait before trying again.' }));

// The caller kicks the durable queue immediately after creating a call.
// The session row and queue entry are the source of truth; push is an
// acceleration path for background/closed apps, while Realtime covers
// foreground delivery.
router.post('/:callId/notify', async (req, res) => {
  const callId = String(req.params.callId || '');
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(callId)) {
    return res.status(400).json({ error: 'Invalid call id' });
  }
  const { data: call, error } = await supabaseAdmin
    .from('call_sessions')
    .select('id,caller_id,status,expires_at')
    .eq('id', callId)
    .maybeSingle();
  if (error) return res.status(503).json({ error: 'Unable to verify call invitation' });
  if (!call || call.caller_id !== req.user.id) return res.status(404).json({ error: 'Call invitation not found' });
  if (call.status !== 'ringing' || new Date(call.expires_at).getTime() <= Date.now()) {
    return res.status(409).json({ error: 'Call invitation is no longer active' });
  }
  try {
    const delivery = await runCallInvitationNotifications({ admin: supabaseAdmin, limit: 1, callId });
    return res.json({ accepted: true, delivery });
  } catch (deliveryError) {
    console.error('[calls] invitation push processing failed:', deliveryError.message || deliveryError);
    return res.status(503).json({ error: 'Call invitation push is temporarily unavailable' });
  }
});

// Never expose the TURN shared secret to the mobile bundle. coturn REST-style
// credentials are short-lived and scoped to the authenticated account.
router.get('/ice-config', (req, res) => {
  res.set('Cache-Control', 'no-store');
  const urls = (process.env.TURN_URLS || '').split(',').map((url) => url.trim()).filter(Boolean);
  const requestedTtl = Number.parseInt(process.env.TURN_CREDENTIAL_TTL_SECONDS || '3600', 10);
  const config = buildIceConfig({
    userId: req.user.id,
    urls,
    secret: process.env.TURN_SHARED_SECRET || '',
    ttlSeconds: requestedTtl,
  });
  return res.json(config);
});

module.exports = router;
