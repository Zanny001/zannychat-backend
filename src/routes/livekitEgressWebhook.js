const express = require('express');
const { supabaseAdmin } = require('../config/supabaseAdmin');
const { getLiveKitEgressConfig, verifyLiveKitWebhook } = require('../services/livekitEgress');
const { finalizeReplay } = require('../services/liveReplayFinalizer');

const router = express.Router();
const rawBody = express.raw({ type: ['application/webhook+json', 'application/json'], limit: '1mb' });

router.post('/egress', rawBody, async (req, res) => {
  const egressConfig = getLiveKitEgressConfig();
  if (!supabaseAdmin || !egressConfig || !Buffer.isBuffer(req.body)) return res.status(503).json({ error: 'LIVE replay webhook is not configured' });
  const verified = verifyLiveKitWebhook(req.body, req.get('authorization'), egressConfig);
  if (!verified) return res.status(401).json({ error: 'Invalid LiveKit webhook signature' });
  let event;
  try {
    event = JSON.parse(req.body.toString('utf8'));
  } catch {
    return res.status(400).json({ error: 'Invalid webhook payload' });
  }
  if (event?.event !== 'egress_ended') return res.status(200).json({ ok: true, ignored: true });
  try {
    const result = await finalizeReplay(event);
    return res.status(200).json({ ok: true, ...result });
  } catch (error) {
    console.error('[live-replay] webhook finalization failed', { message: error.message });
    return res.status(500).json({ error: 'Replay finalization failed' });
  }
});

module.exports = router;
