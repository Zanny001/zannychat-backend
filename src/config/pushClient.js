const { Expo } = require('expo-server-sdk');
const { supabaseAdmin } = require('./supabaseAdmin');
const { summarizePushTickets } = require('./pushTicketSummary');

const expo = new Expo();

// Sends one notification to every registered device for a user. Expo may
// accept a ticket but still fail delivery later; callers therefore receive
// `sent` as accepted-by-Expo, not delivered-to-device.
async function sendPushToUser(userId, { title, body, data }) {
  const { data: tokenRows, error } = await supabaseAdmin
    .from('push_tokens')
    .select('expo_push_token')
    .eq('user_id', userId);

  if (error) throw error;
  if (!tokenRows || tokenRows.length === 0) return { sent: 0, failed: 0 };

  const messages = tokenRows
    .filter((row) => Expo.isExpoPushToken(row.expo_push_token))
    .map((row) => ({
      to: row.expo_push_token,
      sound: 'default',
      title,
      body,
      data: data || {},
    }));

  if (messages.length === 0) return { sent: 0, failed: 0 };

  const chunks = expo.chunkPushNotifications(messages);
  const staleTokens = new Set();
  let sent = 0;
  let failed = 0;
  const acceptedTickets = [];

  for (const chunk of chunks) {
    try {
      const tickets = await expo.sendPushNotificationsAsync(chunk);
      const summary = summarizePushTickets(tickets, chunk);
      sent += summary.accepted;
      failed += summary.failed;
      summary.acceptedTickets.forEach((ticket) => acceptedTickets.push({ ...ticket, user_id: userId }));
      summary.staleTokens.forEach((token) => staleTokens.add(token));
    } catch (err) {
      failed += chunk.length;
      console.error('[push] chunk send failed:', err.message);
    }
  }

  // Persist ticket IDs for later Expo receipt checks. A persistence failure
  // must not turn an accepted push into a failed message-send operation.
  if (acceptedTickets.length > 0 && supabaseAdmin) {
    const rows = acceptedTickets.map((ticket) => ({
      ticket_id: ticket.ticketId, user_id: ticket.user_id, expo_push_token: ticket.token,
      receipt_status: 'pending', sent_at: new Date().toISOString(),
    }));
    const { error: receiptStoreError } = await supabaseAdmin
      .from('push_receipt_tickets').upsert(rows, { onConflict: 'ticket_id', ignoreDuplicates: true });
    if (receiptStoreError) console.error('[push] receipt ticket persistence failed:', receiptStoreError.message);
  }

  if (staleTokens.size > 0) {
    const { error: cleanupError } = await supabaseAdmin
      .from('push_tokens')
      .delete()
      .in('expo_push_token', [...staleTokens]);
    if (cleanupError) console.error('[push] stale-token cleanup failed:', cleanupError.message);
  }

  return { sent, failed };
}

module.exports = { sendPushToUser };
