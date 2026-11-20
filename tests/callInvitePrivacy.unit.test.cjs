const test = require('node:test');
const assert = require('node:assert/strict');
const { evaluateCallInvitePrivacy } = require('../src/utils/callInvitePrivacy.cjs');

const callerId = 'caller-1';
const inviteeId = 'invitee-1';

test('call invite privacy defaults to everyone when no preference row exists', () => {
  assert.deepEqual(evaluateCallInvitePrivacy({
    callerId, inviteeIds: [inviteeId], profileDetails: [], membershipRows: [], blockedRows: [],
  }), { allowed: true, reason: null });
});

test('call invite privacy rejects nobody preference', () => {
  const result = evaluateCallInvitePrivacy({
    callerId, inviteeIds: [inviteeId],
    profileDetails: [{ user_id: inviteeId, call_permission: 'nobody' }],
    membershipRows: [], blockedRows: [],
  });
  assert.equal(result.allowed, false);
  assert.match(result.reason, /do not accept calls/);
});

test('contacts call preference permits a shared conversation', () => {
  const result = evaluateCallInvitePrivacy({
    callerId, inviteeIds: [inviteeId],
    profileDetails: [{ user_id: inviteeId, call_permission: 'contacts' }],
    membershipRows: [
      { user_id: callerId, conversation_id: 'shared-1' },
      { user_id: inviteeId, conversation_id: 'shared-1' },
    ],
    blockedRows: [],
  });
  assert.deepEqual(result, { allowed: true, reason: null });
});

test('contacts call preference rejects callers without a shared conversation', () => {
  const result = evaluateCallInvitePrivacy({
    callerId, inviteeIds: [inviteeId],
    profileDetails: [{ user_id: inviteeId, call_permission: 'contacts' }],
    membershipRows: [{ user_id: callerId, conversation_id: 'private-1' }],
    blockedRows: [],
  });
  assert.equal(result.allowed, false);
  assert.match(result.reason, /existing contacts/);
});

test('call invite privacy rejects blocks in either direction', () => {
  for (const blockedRow of [
    { blocker_id: callerId, blocked_id: inviteeId },
    { blocker_id: inviteeId, blocked_id: callerId },
  ]) {
    const result = evaluateCallInvitePrivacy({
      callerId, inviteeIds: [inviteeId], profileDetails: [], membershipRows: [], blockedRows: [blockedRow],
    });
    assert.equal(result.allowed, false);
  }
});

test('unknown call preference fails closed', () => {
  const result = evaluateCallInvitePrivacy({
    callerId, inviteeIds: [inviteeId],
    profileDetails: [{ user_id: inviteeId, call_permission: 'unexpected' }],
    membershipRows: [], blockedRows: [],
  });
  assert.equal(result.allowed, false);
});
