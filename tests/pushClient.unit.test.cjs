const test = require('node:test');
const assert = require('node:assert/strict');
const { summarizePushTickets } = require('../src/config/pushTicketSummary');

test('counts only successful Expo tickets as accepted', () => {
  const result = summarizePushTickets([
    { status: 'ok', id: 'ticket-1' },
    { status: 'error', message: 'rate limited', details: { error: 'MessageRateExceeded' } },
  ], [{ to: 'ExponentPushToken[one]' }, { to: 'ExponentPushToken[two]' }]);
  assert.deepEqual(result, {
    accepted: 1,
    failed: 1,
    staleTokens: [],
    acceptedTickets: [{ ticketId: 'ticket-1', token: 'ExponentPushToken[one]' }],
  });
});

test('flags only DeviceNotRegistered tokens for cleanup', () => {
  const result = summarizePushTickets([
    { status: 'error', details: { error: 'DeviceNotRegistered' } },
    { status: 'error', details: { error: 'MessageTooBig' } },
  ], [{ to: 'ExponentPushToken[stale]' }, { to: 'ExponentPushToken[valid]' }]);
  assert.equal(result.accepted, 0);
  assert.equal(result.failed, 2);
  assert.deepEqual(result.staleTokens, ['ExponentPushToken[stale]']);
});

test('does not treat missing tickets as successful sends', () => {
  const result = summarizePushTickets([{ status: 'ok' }], [
    { to: 'ExponentPushToken[one]' },
    { to: 'ExponentPushToken[two]' },
  ]);
  assert.equal(result.accepted, 1);
  assert.equal(result.failed, 1);
});

test('handles malformed ticket responses without claiming success', () => {
  const result = summarizePushTickets(null, [{ to: 'ExponentPushToken[one]' }]);
  assert.deepEqual(result, { accepted: 0, failed: 1, staleTokens: [], acceptedTickets: [] });
});
