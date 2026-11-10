const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const route = fs.readFileSync(path.join(__dirname, '../src/routes/calls.js'), 'utf8');

test('call notification kick is authenticated, caller-bound, and limited to active invitations', () => {
  assert.ok(route.includes('router.use(requireAuth'));
  assert.ok(route.includes("router.post('/:callId/notify'"));
  assert.ok(route.includes('call.caller_id !== req.user.id'));
  assert.ok(route.includes("call.status !== 'ringing'"));
  assert.ok(route.includes('runCallInvitationNotifications'));
});

test('call notification kick only processes its validated call id', () => {
  assert.ok(route.includes('runCallInvitationNotifications({ admin: supabaseAdmin, limit: 1, callId })'));
});

test('native VoIP token registration and call-end delivery routes are authenticated and participant-bound', () => {
  assert.ok(route.includes("router.post('/voip-token'"));
  assert.ok(route.includes("router.delete('/voip-token'"));
  assert.ok(route.includes("router.post('/:callId/end-notify'"));
  assert.ok(route.includes('sendCallEndedToUser'));
  assert.ok(route.includes("['APNS_VOIP', 'APNS_ALERT', 'FCM']"));
  assert.ok(route.includes("type === 'FCM' ? 'android' : 'ios'"));
});

test('native call-end reconciliation is signed and mounted before user authentication middleware', () => {
  const eventRoute = route.indexOf("router.post('/native-event'");
  const authMiddleware = route.indexOf('router.use(requireAuth');
  assert.ok(eventRoute >= 0 && authMiddleware > eventRoute);
  assert.ok(route.includes('verifyCallEventToken(callId, token)'));
  assert.ok(route.includes("reason === 'unanswered' ? 'missed' : 'declined'"));
});
