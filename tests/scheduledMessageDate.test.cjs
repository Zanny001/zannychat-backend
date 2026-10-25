const test = require('node:test');
const assert = require('node:assert/strict');
const { parseScheduledMessageDate, isScheduledMessageTimeAllowed } = require('../src/utils/scheduledMessageDate.cjs');

test('scheduled-message parser accepts valid explicit ISO timestamps', () => {
  assert.equal(parseScheduledMessageDate('2032-02-29T12:30:00Z'), Date.parse('2032-02-29T12:30:00Z'));
  assert.equal(parseScheduledMessageDate('2032-02-29T12:30:00+01:00'), Date.parse('2032-02-29T12:30:00+01:00'));
  assert.equal(parseScheduledMessageDate('2032-02-29T12:30Z'), Date.parse('2032-02-29T12:30Z'));
  assert.equal(parseScheduledMessageDate('0000-02-29T12:30:00Z'), Date.parse('0000-02-29T12:30:00Z'));
});

test('scheduled-message parser rejects impossible dates and malformed timestamps', () => {
  for (const value of [
    '2032-02-30T12:30:00Z', '2031-02-29T12:30:00Z', '2032-13-01T12:30:00Z',
    '2032-01-01T25:00:00Z', '2032-01-01T12:60:00Z', '2032-01-01T12:00:60Z',
    '2032-01-01T12:00:00+15:00', '2032-01-01T12:00:00+14:30',
    '0100-02-29T12:30:00Z',
    'tomorrow', '2032-01-01', 123, null,
  ]) assert.equal(Number.isNaN(parseScheduledMessageDate(value)), true, String(value));
});

test('scheduled-message date policy enforces the 1-minute to 30-day window', () => {
  const now = Date.parse('2032-02-01T00:00:00Z');
  assert.equal(isScheduledMessageTimeAllowed('2032-02-01T00:01:00Z', now), true);
  assert.equal(isScheduledMessageTimeAllowed('2032-02-01T00:00:59Z', now), false);
  assert.equal(isScheduledMessageTimeAllowed('2032-03-03T00:00:01Z', now), false);
  assert.equal(isScheduledMessageTimeAllowed('2032-02-30T00:00:00Z', now), false);
});
