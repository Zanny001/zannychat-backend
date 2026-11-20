const test = require('node:test');
const assert = require('node:assert/strict');
const { evaluateGroupInvitePrivacy } = require('../src/utils/groupInvitePrivacy.cjs');

const inviterId = 'inviter-1';
const inviteeId = 'invitee-1';

test('group invite privacy defaults to everyone when no preference row exists', () => {
  assert.deepEqual(evaluateGroupInvitePrivacy({
    inviterId, inviteeIds: [inviteeId], profileDetails: [], membershipRows: [], blockedRows: [],
  }), { allowed: true, reason: null });
});

test('group invite privacy rejects nobody preference', () => {
  const result = evaluateGroupInvitePrivacy({
    inviterId, inviteeIds: [inviteeId],
    profileDetails: [{ user_id: inviteeId, group_invite_permission: 'nobody' }],
    membershipRows: [], blockedRows: [],
  });
  assert.equal(result.allowed, false);
  assert.match(result.reason, /do not accept group invitations/);
});

test('contacts preference allows an inviter with a shared conversation', () => {
  const result = evaluateGroupInvitePrivacy({
    inviterId, inviteeIds: [inviteeId],
    profileDetails: [{ user_id: inviteeId, group_invite_permission: 'contacts' }],
    membershipRows: [
      { user_id: inviterId, conversation_id: 'shared-1' },
      { user_id: inviteeId, conversation_id: 'shared-1' },
    ],
    blockedRows: [],
  });
  assert.deepEqual(result, { allowed: true, reason: null });
});

test('contacts preference rejects an inviter without a shared conversation', () => {
  const result = evaluateGroupInvitePrivacy({
    inviterId, inviteeIds: [inviteeId],
    profileDetails: [{ user_id: inviteeId, group_invite_permission: 'contacts' }],
    membershipRows: [{ user_id: inviterId, conversation_id: 'private-1' }],
    blockedRows: [],
  });
  assert.equal(result.allowed, false);
});

test('group invite privacy rejects blocks in either direction', () => {
  for (const blockedRow of [
    { blocker_id: inviterId, blocked_id: inviteeId },
    { blocker_id: inviteeId, blocked_id: inviterId },
  ]) {
    const result = evaluateGroupInvitePrivacy({
      inviterId, inviteeIds: [inviteeId], profileDetails: [], membershipRows: [], blockedRows: [blockedRow],
    });
    assert.equal(result.allowed, false);
    assert.match(result.reason, /cannot be invited/);
  }
});


test('unknown group invite preference fails closed', () => {
  const result = evaluateGroupInvitePrivacy({
    inviterId, inviteeIds: [inviteeId],
    profileDetails: [{ user_id: inviteeId, group_invite_permission: 'unexpected' }],
    membershipRows: [], blockedRows: [],
  });
  assert.equal(result.allowed, false);
  assert.match(result.reason, /unavailable invitation preference/);
});
