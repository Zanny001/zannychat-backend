// Expo tickets mean a notification was accepted for processing, not that a
// device received or displayed it. Count only successful tickets and retain
// ticket IDs so a later receipt lookup can confirm provider-side delivery.
function summarizePushTickets(tickets, chunk) {
  const result = { accepted: 0, failed: 0, staleTokens: [], acceptedTickets: [] };
  const safeTickets = Array.isArray(tickets) ? tickets : [];

  safeTickets.slice(0, chunk.length).forEach((ticket, index) => {
    if (ticket?.status === 'ok') {
      result.accepted += 1;
      if (typeof ticket.id === 'string' && ticket.id && chunk[index]?.to) {
        result.acceptedTickets.push({ ticketId: ticket.id, token: chunk[index].to });
      }
      return;
    }
    result.failed += 1;
    if (ticket?.details?.error === 'DeviceNotRegistered' && chunk[index]?.to) {
      result.staleTokens.push(chunk[index].to);
    }
  });

  // A truncated or malformed response must not be counted as accepted.
  if (safeTickets.length < chunk.length) result.failed += chunk.length - safeTickets.length;
  return result;
}

module.exports = { summarizePushTickets };
