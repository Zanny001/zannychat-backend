function evaluateCallInvitePrivacy({ callerId, inviteeIds, profileDetails = [], membershipRows = [], blockedRows = [] }) {
  const invited = new Set(Array.isArray(inviteeIds) ? inviteeIds : []);
  const blocked = (blockedRows || []).some((row) =>
    (row.blocker_id === callerId && invited.has(row.blocked_id)) ||
    (row.blocked_id === callerId && invited.has(row.blocker_id))
  );
  if (blocked) return { allowed: false, reason: 'One or more selected people do not accept calls from this account.' };

  const conversationsByUser = new Map();
  for (const row of membershipRows || []) {
    if (!row?.conversation_id || !row?.user_id) continue;
    if (!conversationsByUser.has(row.user_id)) conversationsByUser.set(row.user_id, new Set());
    conversationsByUser.get(row.user_id).add(row.conversation_id);
  }
  const callerConversations = conversationsByUser.get(callerId) || new Set();
  const preferences = new Map((profileDetails || []).map((row) => [row.user_id, row.call_permission]));

  for (const inviteeId of invited) {
    const permission = preferences.get(inviteeId) || 'everyone';
    if (!['everyone', 'contacts', 'nobody'].includes(permission)) {
      return { allowed: false, reason: 'One or more selected people have an unavailable call preference.' };
    }
    if (permission === 'nobody') {
      return { allowed: false, reason: 'One or more selected people do not accept calls.' };
    }
    if (permission === 'contacts') {
      const inviteeConversations = conversationsByUser.get(inviteeId) || new Set();
      const shared = [...inviteeConversations].some((id) => callerConversations.has(id));
      if (!shared) return { allowed: false, reason: 'One or more selected people only accept calls from existing contacts.' };
    }
  }

  return { allowed: true, reason: null };
}

module.exports = { evaluateCallInvitePrivacy };
