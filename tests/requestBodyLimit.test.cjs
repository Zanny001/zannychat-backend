const test = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');
const app = require('../src/index');

test('API rejects oversized JSON before authentication or route work', async () => {
  const payload = { data: 'x'.repeat(110 * 1024) };
  const response = await request(app)
    .post('/safety/block')
    .set('Content-Type', 'application/json')
    .send(payload);

  assert.equal(response.status, 413);
  assert.deepEqual(response.body, { error: 'Request body too large' });
});
