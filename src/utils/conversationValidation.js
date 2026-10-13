'use strict';

const { isUuid } = require('./safetyValidation');

const MAX_GROUP_PARTICIPANTS = 256;
const MAX_GROUP_NAME_LENGTH = 80;

function validateDirectParticipantId(value, currentUserId) {
  if (!isUuid(value)) return { ok: false, error: 'participantId must be a valid UUID' };
  if (value === currentUserId) return { ok: false, error: 'Cannot start a conversation with yourself' };
  return { ok: true };
}

function validateGroupInput(participantIds, name, currentUserId) {
  if (!Array.isArray(participantIds) || participantIds.length < 2) {
    return { ok: false, error: 'participantIds must include at least 2 other people' };
  }
  if (participantIds.length > MAX_GROUP_PARTICIPANTS) {
    return { ok: false, error: `A group can include at most ${MAX_GROUP_PARTICIPANTS} invited participants` };
  }
  if (!participantIds.every(isUuid)) {
    return { ok: false, error: 'Every participantId must be a valid UUID' };
  }
  if (typeof name !== 'string' || !name.trim()) {
    return { ok: false, error: 'A group name is required' };
  }
  if (name.trim().length > MAX_GROUP_NAME_LENGTH) {
    return { ok: false, error: `Group name must be ${MAX_GROUP_NAME_LENGTH} characters or fewer` };
  }
  const uniqueOtherIds = [...new Set(participantIds)].filter((id) => id !== currentUserId);
  if (uniqueOtherIds.length < 2) {
    return { ok: false, error: 'A group requires at least 2 other people' };
  }
  return { ok: true, participantIds: uniqueOtherIds, name: name.trim() };
}

module.exports = {
  MAX_GROUP_PARTICIPANTS,
  MAX_GROUP_NAME_LENGTH,
  validateDirectParticipantId,
  validateGroupInput,
};
