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

test('rate limiter returns 429 with standard headers after the configured budget', async () => {
  const express = require('express');
  const request = require('supertest');
  const { makeLimiter } = require('../src/middleware/rateLimit');
  const app = express();
  app.use((req, res, next) => { req.user = { id: 'rate-limit-regression-user' }; next(); });
  app.use(makeLimiter({ windowMs: 60 * 1000, max: 2, error: 'Too many test requests.' }));
  app.get('/', (req, res) => res.json({ ok: true }));

  assert.equal((await request(app).get('/')).status, 200);
  assert.equal((await request(app).get('/')).status, 200);
  const limited = await request(app).get('/');
  assert.equal(limited.status, 429);
  assert.deepEqual(limited.body, { error: 'Too many test requests.' });
  assert.ok(limited.headers['ratelimit-limit']);
});
