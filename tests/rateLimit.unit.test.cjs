const test = require('node:test');
const assert = require('node:assert/strict');
const { keyForRequest } = require('../src/middleware/rateLimit');

test('authenticated rate-limit keys are isolated by verified user id', () => {
  assert.equal(keyForRequest({ user: { id: 'user-a' }, ip: '203.0.113.10' }), 'user:user-a');
  assert.equal(keyForRequest({ user: { id: 'user-b' }, ip: '203.0.113.10' }), 'user:user-b');
});

test('unauthenticated rate-limit keys fall back to the client IP', () => {
  assert.equal(keyForRequest({ ip: '203.0.113.10' }), 'ip:203.0.113.10');
});

test('IPv6 rate-limit keys group addresses within the same /56 subnet', () => {
  const first = keyForRequest({ ip: '2001:db8:abcd:1200::1' });
  const second = keyForRequest({ ip: '2001:db8:abcd:12ff::9' });
  assert.equal(first, second);
});
