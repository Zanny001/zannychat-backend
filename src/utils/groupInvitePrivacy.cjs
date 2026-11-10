/** Evaluate recipient-side group invitation privacy before creating a group. */
function evaluateGroupInvitePrivacy({ inviterId, inviteeIds, profileDetails = [], membershipRows = [], blockedRows = [] }) {
  const invited = new Set(Array.isArray(inviteeIds) ? inviteeIds : []);
  const blocked = (blockedRows || []).some((row) =>
    (row.blocker_id === inviterId && invited.has(row.blocked_id)) ||
    (row.blocked_id === inviterId && invited.has(row.blocker_id))
  );
  if (blocked) return { allowed: false, reason: 'One or more selected members cannot be invited.' };

  const contacts = new Set();
  const conversationsByUser = new Map();
  for (const row of membershipRows || []) {
    if (!row?.conversation_id || !row?.user_id) continue;
    if (!conversationsByUser.has(row.user_id)) conversationsByUser.set(row.user_id, new Set());
    conversationsByUser.get(row.user_id).add(row.conversation_id);
  }
  const inviterConversations = conversationsByUser.get(inviterId) || new Set();
  for (const inviteeId of invited) {
    const shared = conversationsByUser.get(inviteeId) || new Set();
    if ([...shared].some((conversationId) => inviterConversations.has(conversationId))) contacts.add(inviteeId);
  }

  const preferenceByUser = new Map((profileDetails || []).map((row) => [row.user_id, row.group_invite_permission]));
  for (const inviteeId of invited) {
    const permission = preferenceByUser.get(inviteeId) || 'everyone';
    if (permission === 'nobody' || (permission === 'contacts' && !contacts.has(inviteeId))) {
      return { allowed: false, reason: 'One or more selected members do not accept group invitations from this account.' };
    }
  }
  return { allowed: true, reason: null };
}

module.exports = { evaluateGroupInvitePrivacy };
