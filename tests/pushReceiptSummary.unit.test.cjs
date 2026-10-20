const test = require('node:test');
const assert = require('node:assert/strict');
const { summarizePushReceipts } = require('../src/config/pushReceiptSummary');

test('separates delivered receipts from missing receipts', () => {
  const rows = [{ ticket_id: 'ticket-ok' }, { ticket_id: 'ticket-later' }];
  const summary = summarizePushReceipts({ 'ticket-ok': { status: 'ok' } }, rows);
  assert.equal(summary.checked, 1);
  assert.equal(summary.delivered, 1);
  assert.equal(summary.pending, 1);
  assert.deepEqual(summary.updates, [{ ticket_id: 'ticket-ok', receipt_status: 'ok', receipt_error: null }]);
});

test('records receipt errors and identifies unregistered device tokens', () => {
  const summary = summarizePushReceipts({
    'ticket-stale': { status: 'error', message: 'Device not registered', details: { error: 'DeviceNotRegistered' } },
    'ticket-bad': { status: 'error', message: 'Payload rejected', details: { error: 'MessageTooBig' } },
  }, [
    { ticket_id: 'ticket-stale', expo_push_token: 'ExponentPushToken[stale]' },
    { ticket_id: 'ticket-bad', expo_push_token: 'ExponentPushToken[valid]' },
  ]);
  assert.equal(summary.checked, 2);
  assert.equal(summary.failed, 2);
  assert.deepEqual(summary.staleTokens, ['ExponentPushToken[stale]']);
  assert.equal(summary.updates[0].receipt_error, 'DeviceNotRegistered');
});

test('handles malformed receipt payloads without marking delivery', () => {
  const summary = summarizePushReceipts(null, [{ ticket_id: 'ticket-1' }]);
  assert.equal(summary.delivered, 0);
  assert.equal(summary.pending, 1);
  assert.equal(summary.updates.length, 0);
});
