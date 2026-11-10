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
  assert.match(route, /runCallInvitationNotifications\(\\{ admin: supabaseAdmin, limit: 1, callId \\}\)/);
});
