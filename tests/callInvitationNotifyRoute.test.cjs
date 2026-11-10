const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const route = fs.readFileSync(path.join(__dirname, '../src/routes/calls.js'), 'utf8');

test('call notification kick is authenticated, caller-bound, and limited to active invitations', () => {
  assert.match(route, /router\\.use\\(requireAuth/);
  assert.match(route, /router\\.post\\('\\/:callId\\/notify'/);
  assert.match(route, /call\\.caller_id !== req\\.user\\.id/);
  assert.match(route, /call\\.status !== 'ringing'/);
  assert.match(route, /runCallInvitationNotifications/);
});