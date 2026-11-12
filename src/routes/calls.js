const express = require('express');
const { requireAuth } = require('../middleware/requireAuth');
const { makeLimiter } = require('../middleware/rateLimit');
const { buildIceConfig } = require('../utils/turnCredentials.cjs');
const { runCallInvitationNotifications } = require('../jobs/callInvitationNotifications');
const { enqueueCallEndNotification } = require('../jobs/callEndNotifications');
const { supabaseAdmin } = require('../config/supabaseAdmin');

const router = express.Router();

 // This signed, call-scoped endpoint is intentionally registered before
 // requireAuth: Android's native receiver may run while the app is killed.
 router.post('/native-event', makeLimiter({ windowMs: 60 * 1000, max: 20, error: 'Native call events are rate-limited.' }), async (req, res) => {
   const callId = typeof req.body?.callId === 'string' ? req.body.callId.trim() : '';
   const token = typeof req.body?.token === 'string' ? req.body.token.trim() : '';
   const reason = typeof req.body?.reason === 'string' ? req.body.reason : '';
   if (!/^[0-9a-f-]{36}$/i.test(callId) || !token) return res.status(400).json({ error: 'Invalid native call event' });
   const { verifyCallEventToken, getCallEventTokenActor } = require('../services/callEventToken');
   if (!verifyCallEventToken(callId, token)) return res.status(403).json({ error: 'Invalid or expired native call event' });
   const { data: call, error } = await supabaseAdmin.from('call_sessions')
     .select('id,caller_id,callee_id,status').eq('id', callId).maybeSingle();
   if (error) return res.status(503).json({ error: 'Could not inspect call state' });
   if (!call) return res.status(404).json({ error: 'Call not found' });
   // Older in-flight invitation tokens were callee-scoped by delivery; new
   // tokens cryptographically identify their participant.
   const actorId = getCallEventTokenActor(callId, token) || call.callee_id;
   if (![call.caller_id, call.callee_id].includes(actorId)) return res.status(403).json({ error: 'Native call token is not valid for a participant' });
   if (!['ringing', 'accepted'].includes(call.status)) return res.json({ updated: false, alreadyEnded: true });
   const nextStatus = call.status === 'accepted' ? 'ended'
     : actorId === call.caller_id ? 'cancelled'
       : reason === 'unanswered' ? 'missed' : 'declined';
   const { data: updated, error: updateError } = await supabaseAdmin.from('call_sessions')
     .update({ status: nextStatus }).eq('id', callId).in('status', ['ringing', 'accepted'])
     .select('id,status').maybeSingle();
   if (updateError) return res.status(503).json({ error: 'Could not update call state' });
   const recipientId = actorId === call.caller_id ? call.callee_id : call.caller_id;
   let delivery = null;
   if (updated) {
     delivery = await enqueueCallEndNotification({
       admin: supabaseAdmin, callId, recipientId, terminalStatus: updated.status,
     });
   }
   return res.json({ updated: Boolean(updated), status: updated?.status || nextStatus, notification: delivery });
 });

router.use(requireAuth, makeLimiter({ windowMs: 60 * 1000, max: 12, error: 'Call setup is rate-limited. Please wait before trying again.' }));

// Either authenticated participant may mint a short-lived native-end token.
// This covers caller-side outgoing sessions and callee-side incoming sessions
// created from the Expo push fallback when native VoIP delivery is unavailable.
router.post('/:callId/native-event-token', async (req, res) => {
  const callId = String(req.params.callId || '');
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(callId)) {
    return res.status(400).json({ error: 'Invalid call id' });
  }
  const { data: call, error } = await supabaseAdmin.from('call_sessions')
    .select('id,caller_id,callee_id,status,expires_at').eq('id', callId).maybeSingle();
  if (error) return res.status(503).json({ error: 'Could not inspect call state' });
  if (!call || ![call.caller_id, call.callee_id].includes(req.user.id)) return res.status(404).json({ error: 'Call invitation not found' });
  if (call.status !== 'ringing' || new Date(call.expires_at).getTime() <= Date.now()) {
    return res.status(409).json({ error: 'Call invitation is no longer active' });
  }
  const { createCallEventToken } = require('../services/callEventToken');
  const eventToken = createCallEventToken(callId, Date.now(), req.user.id);
  if (!eventToken) return res.status(503).json({ error: 'Native call reconciliation is not configured' });
  res.set('Cache-Control', 'no-store');
  return res.json(eventToken);
});

// The caller kicks the durable queue immediately after creating a call.
// The session row and queue entry are the source of truth; push is an
// acceleration path for background/closed apps, while Realtime covers
// foreground delivery.

// Register an OS-level VoIP token (APNs PushKit or FCM). Tokens are private
// device credentials and are only written/read by the authenticated API.
router.post('/voip-token', async (req, res) => {
  const token = typeof req.body?.token === 'string' ? req.body.token.trim() : '';
  const type = req.body?.type;
  if (token.length < 16 || token.length > 4096 || !['APNS_VOIP', 'APNS_ALERT', 'FCM'].includes(type)) {
    return res.status(400).json({ error: 'Invalid VoIP push token' });
  }
  const platform = type === 'FCM' ? 'android' : 'ios';
  const { error } = await supabaseAdmin.from('call_voip_tokens').upsert({
    user_id: req.user.id,
    token,
    token_type: type,
    platform,
    updated_at: new Date().toISOString(),
  }, { onConflict: 'token' });
  if (error) {
    console.error('[calls] VoIP token registration failed:', error.message || error);
    return res.status(503).json({ error: 'Could not register call notifications' });
  }
  return res.json({ registered: true, platform });
});

router.post('/:callId/end-notify', async (req, res) => {
  const callId = req.params.callId;
  const { data: call, error } = await supabaseAdmin.from('call_sessions')
    .select('id,caller_id,callee_id,status').eq('id', callId).maybeSingle();
  if (error) return res.status(503).json({ error: 'Could not inspect call state' });
  if (!call) return res.status(404).json({ error: 'Call not found' });
  if (![call.caller_id, call.callee_id].includes(req.user.id)) {
    return res.status(403).json({ error: 'Not a participant in this call' });
  }
  if (!['declined', 'cancelled', 'ended', 'missed', 'failed'].includes(call.status)) {
    return res.status(409).json({ error: 'Call has not ended' });
  }
  const recipientId = req.user.id === call.caller_id ? call.callee_id : call.caller_id;
  const delivery = await enqueueCallEndNotification({
    admin: supabaseAdmin, callId: call.id, recipientId, terminalStatus: call.status,
  });
  return res.json({ sent: Number(delivery.delivered) || 0, queued: true, notification: delivery });
});

router.delete('/voip-token', async (req, res) => {
  const removeAll = req.body?.all === true;
  const token = typeof req.body?.token === 'string' ? req.body.token.trim() : '';
  if (!removeAll && (!token || token.length > 4096)) {
    return res.status(400).json({ error: 'Provide a VoIP token or request account-wide cleanup' });
  }
  let query = supabaseAdmin.from('call_voip_tokens').delete().eq('user_id', req.user.id);
  if (!removeAll) query = query.eq('token', token);
  const { error } = await query;
  if (error) return res.status(503).json({ error: 'Could not remove call notifications' });
  return res.json({ removed: true, scope: removeAll ? 'account' : 'device' });
});

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
