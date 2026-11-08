const test = require('node:test');
const assert = require('node:assert/strict');
const { evaluateGroupInvitePrivacy } = require('../src/utils/groupInvitePrivacy.cjs');

const inviterId = 'owner';
const friendId = 'friend';
const strangerId = 'stranger';

test('allows everyone and contacts-only invitees when inviter is a contact', () => {
  const result = evaluateGroupInvitePrivacy({
    inviterId,
    inviteeIds: [friendId, strangerId],
    profileDetails: [{ user_id: friendId, group_invite_permission: 'contacts' }],
    membershipRows: [
      { conversation_id: 'direct-1', user_id: inviterId },
      { conversation_id: 'direct-1', user_id: friendId },
    ],
  });
  assert.deepEqual(result, { allowed: true, reason: null });
});

test('rejects a nobody preference and a contacts-only invitation from a stranger', () => {
  assert.equal(evaluateGroupInvitePrivacy({
    inviterId, inviteeIds: [friendId],
    profileDetails: [{ user_id: friendId, group_invite_permission: 'nobody' }],
  }).allowed, false);
  assert.equal(evaluateGroupInvitePrivacy({
    inviterId, inviteeIds: [strangerId],
    profileDetails: [{ user_id: strangerId, group_invite_permission: 'contacts' }],
  }).allowed, false);
});

test('rejects a group invitation when either side has blocked the other', () => {
  const result = evaluateGroupInvitePrivacy({
    inviterId, inviteeIds: [friendId],
    blockedRows: [{ blocker_id: friendId, blocked_id: inviterId }],
  });
  assert.equal(result.allowed, false);
});

test('missing preference rows preserve legacy everyone behavior', () => {
  assert.equal(evaluateGroupInvitePrivacy({ inviterId, inviteeIds: [friendId] }).allowed, true);
});

test('group route checks recipient privacy and block state before inserting membership', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const route = fs.readFileSync(path.join(__dirname, '../src/routes/conversations.js'), 'utf8');
  const groupRoute = route.slice(route.indexOf("router.post('/group'"), route.indexOf("router.post('/:conversationId/invites'"));
  assert.match(groupRoute, /profile_details/);
  assert.match(groupRoute, /group_invite_permission/);
  assert.match(groupRoute, /blocked_users/);
  assert.match(groupRoute, /evaluateGroupInvitePrivacy/);
  assert.ok(groupRoute.indexOf('evaluateGroupInvitePrivacy') < groupRoute.indexOf(".from('conversations')"));
});
