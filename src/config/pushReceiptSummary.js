function summarizePushReceipts(receipts, ticketRows) {
  const summary = { checked: 0, delivered: 0, failed: 0, pending: 0, staleTokens: [], updates: [] };
  const safeReceipts = receipts && typeof receipts === 'object' ? receipts : {};
  for (const row of ticketRows || []) {
    if (!row?.ticket_id || !Object.prototype.hasOwnProperty.call(safeReceipts, row.ticket_id)) {
      summary.pending += 1;
      continue;
    }
    const receipt = safeReceipts[row.ticket_id];
    summary.checked += 1;
    if (receipt?.status === 'ok') {
      summary.delivered += 1;
      summary.updates.push({ ticket_id: row.ticket_id, receipt_status: 'ok', receipt_error: null });
    } else {
      const error = receipt?.details?.error || receipt?.message || 'UnknownReceiptError';
      summary.failed += 1;
      summary.updates.push({ ticket_id: row.ticket_id, receipt_status: 'error', receipt_error: String(error).slice(0, 200) });
      if (error === 'DeviceNotRegistered' && row.expo_push_token) summary.staleTokens.push(row.expo_push_token);
    }
  }
  return summary;
}
module.exports = { summarizePushReceipts };
