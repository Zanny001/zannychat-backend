const { Expo } = require('expo-server-sdk');
const { supabaseAdmin } = require('./supabaseAdmin');

const expo = new Expo();

// Sends one notification to every device a user is signed in on
// (push_tokens can have more than one row per user_id — multiple
// devices). Silently drops tokens Expo says are no longer valid
// (DeviceNotRegistered) rather than erroring — a stale token from a
// reinstalled app is routine, not a failure worth surfacing.
async function sendPushToUser(userId, { title, body, data }) {
  const { data: tokenRows, error } = await supabaseAdmin
    .from('push_tokens')
    .select('expo_push_token')
    .eq('user_id', userId);

  if (error) throw error;
  if (!tokenRows || tokenRows.length === 0) return { sent: 0 };

  const messages = tokenRows
    .filter((row) => Expo.isExpoPushToken(row.expo_push_token))
    .map((row) => ({
      to: row.expo_push_token,
      sound: 'default',
      title,
      body,
      data: data || {},
    }));

  if (messages.length === 0) return { sent: 0 };

  const chunks = expo.chunkPushNotifications(messages);
  const staleTokens = [];

  for (const chunk of chunks) {
    try {
      const tickets = await expo.sendPushNotificationsAsync(chunk);
      tickets.forEach((ticket, i) => {
        if (ticket.status === 'error' && ticket.details?.error === 'DeviceNotRegistered') {
          staleTokens.push(chunk[i].to);
        }
      });
    } catch (err) {
      console.error('[push] chunk send failed:', err.message);
    }
  }

  if (staleTokens.length > 0) {
    await supabaseAdmin.from('push_tokens').delete().in('expo_push_token', staleTokens);
  }

  return { sent: messages.length - staleTokens.length };
}

module.exports = { sendPushToUser };
