'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { validateDirectParticipantId, validateGroupInput, MAX_GROUP_PARTICIPANTS } = require('../src/utils/conversationValidation');

const ME = 'a1b2c3d4-e5f6-4789-8abc-1234567890ab';
const OTHER = 'b1b2c3d4-e5f6-4789-8abc-1234567890ab';
const THIRD = 'c1b2c3d4-e5f6-4789-8abc-1234567890ab';

test('direct conversations reject malformed IDs and self-conversations', () => {
  assert.deepEqual(validateDirectParticipantId(OTHER, ME), { ok: true });
  assert.equal(validateDirectParticipantId('not-a-uuid', ME).ok, false);
  assert.equal(validateDirectParticipantId(ME, ME).error, 'Cannot start a conversation with yourself');
});

test('groups require at least two distinct other valid participants', () => {
  assert.deepEqual(validateGroupInput([OTHER, THIRD], 'Trip', ME), { ok: true, participantIds: [OTHER, THIRD], name: 'Trip' });
  assert.equal(validateGroupInput([OTHER, OTHER], 'Trip', ME).ok, false);
  assert.equal(validateGroupInput([OTHER, 'bad-id'], 'Trip', ME).ok, false);
  assert.equal(validateGroupInput([ME, OTHER, OTHER], 'Trip', ME).ok, false);
});

test('groups reject oversized lists and unsafe names without throwing', () => {
  assert.equal(validateGroupInput(Array(MAX_GROUP_PARTICIPANTS + 1).fill(OTHER), 'Trip', ME).ok, false);
  assert.equal(validateGroupInput([OTHER, THIRD], null, ME).ok, false);
  assert.equal(validateGroupInput([OTHER, THIRD], '   ', ME).ok, false);
  assert.equal(validateGroupInput([OTHER, THIRD], 'x'.repeat(81), ME).ok, false);
  assert.equal(validateGroupInput([OTHER, THIRD], '  Family  ', ME).name, 'Family');
});
