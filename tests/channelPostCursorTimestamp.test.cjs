'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { normalizeChannelPostCursorTimestamp } = require('../src/utils/channelPostCursor');

test('accepts valid UTC and offset timestamps', () => {
  assert.equal(normalizeChannelPostCursorTimestamp('2024-02-29T12:30:45Z'), '2024-02-29T12:30:45Z');
  assert.equal(normalizeChannelPostCursorTimestamp('2026-10-23T12:00:00.123456+05:30'), '2026-10-23T12:00:00.123456+05:30');
  assert.equal(normalizeChannelPostCursorTimestamp('2026-10-23T12:00:00-14:00'), '2026-10-23T12:00:00-14:00');
});

test('preserves microsecond precision for stable pagination cursors', () => {
  const timestamp = '2026-10-23T12:00:00.123456Z';
  assert.equal(normalizeChannelPostCursorTimestamp(timestamp), timestamp);
});

test('rejects impossible calendar dates and malformed timestamps', () => {
  for (const value of [
    '2023-02-29T12:00:00Z', '2026-02-30T12:00:00Z', '2026-13-01T12:00:00Z',
    '2026-10-23', '2026-10-23T12:00:00', '2026-10-23T25:00:00Z',
    '2026-10-23T12:60:00Z', '2026-10-23T12:00:60Z', '2026-10-23T12:00:00.1234567Z',
    '2026-10-23T12:00:00+14:01', '2026-10-23T12:00:00+15:00',
    '2026-10-23T12:00:00+05:99', ' 2026-10-23T12:00:00Z', '2026-10-23T12:00:00Z ' ,
  ]) assert.equal(normalizeChannelPostCursorTimestamp(value), null, value);
});

test('handles Gregorian century leap-year rules', () => {
  assert.equal(normalizeChannelPostCursorTimestamp('2000-02-29T00:00:00Z'), '2000-02-29T00:00:00Z');
  assert.equal(normalizeChannelPostCursorTimestamp('2100-02-29T00:00:00Z'), null);
});
