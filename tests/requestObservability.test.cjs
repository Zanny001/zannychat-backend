const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { requestObservability } = require('../src/middleware/requestObservability');

test('emits a server-generated request id and structured route-level timing without URL data', () => {
  const req = {
    method: 'GET',
    path: '/messages/private-search-term',
    originalUrl: '/messages/private-search-term?token=must-not-log',
    baseUrl: '/messages',
    route: { path: '/:messageId' },
  };
  const res = new EventEmitter();
  res.statusCode = 200;
  const headers = {};
  res.setHeader = (name, value) => { headers[name] = value; };
  const previousLog = console.log;
  let output;
  console.log = (value) => { output = value; };
  try {
    let continued = false;
    requestObservability(req, res, () => { continued = true; });
    assert.equal(continued, true);
    assert.match(headers['X-Request-Id'], /^[0-9a-f-]{36}$/i);
    res.emit('finish');
  } finally {
    console.log = previousLog;
  }

  const event = JSON.parse(output);
  assert.equal(event.event, 'http_request');
  assert.equal(event.requestId, headers['X-Request-Id']);
  assert.equal(event.route, '/messages/:messageId');
  assert.equal(event.method, 'GET');
  assert.equal(event.statusCode, 200);
  assert.equal(typeof event.durationMs, 'number');
  assert.ok(event.durationMs >= 0);
  assert.equal(output.includes('private-search-term'), false);
  assert.equal(output.includes('must-not-log'), false);
});

test('classifies server failures without logging request payloads or client identifiers', () => {
  const req = { method: 'POST', path: '/account/reset', originalUrl: '/account/reset?email=private@example.com' };
  const res = new EventEmitter();
  res.statusCode = 503;
  res.setHeader = () => {};
  const previousLog = console.log;
  let output;
  console.log = (value) => { output = value; };
  try {
    requestObservability(req, res, () => {});
    res.emit('finish');
  } finally {
    console.log = previousLog;
  }
  const event = JSON.parse(output);
  assert.equal(event.level, 'error');
  assert.equal(event.route, 'unmatched');
  assert.equal(output.includes('private@example.com'), false);
});
