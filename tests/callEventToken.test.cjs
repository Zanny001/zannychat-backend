const test = require('node:test');
const assert = require('node:assert/strict');
const { createCallEventToken, verifyCallEventToken, TOKEN_TTL_SECONDS } = require('../src/services/callEventToken');

test('native call event token is scoped to one call and has a bounded lifetime', () => {
  const previous = process.env.CALL_EVENT_SIGNING_SECRET;
  process.env.CALL_EVENT_SIGNING_SECRET = 'unit-test-call-event-secret';
  try {
    const now = Date.parse('2026-11-10T00:00:00.000Z');
    const created = createCallEventToken('123e4567-e89b-12d3-a456-426614174000', now);
    assert.ok(created?.token);
    assert.equal(Date.parse(created.expiresAt), now + TOKEN_TTL_SECONDS * 1000);
    assert.equal(verifyCallEventToken('123e4567-e89b-12d3-a456-426614174000', created.token, now), true);
    assert.equal(verifyCallEventToken('123e4567-e89b-12d3-a456-426614174001', created.token, now), false);
    assert.equal(verifyCallEventToken('123e4567-e89b-12d3-a456-426614174000', created.token, now + (TOKEN_TTL_SECONDS + 1) * 1000), false);
    assert.equal(verifyCallEventToken('123e4567-e89b-12d3-a456-426614174000', created.token + 'x', now), false);
  } finally {
    if (previous === undefined) delete process.env.CALL_EVENT_SIGNING_SECRET;
    else process.env.CALL_EVENT_SIGNING_SECRET = previous;
  }
});
