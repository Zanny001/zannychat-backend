const test = require('node:test');
const assert = require('node:assert/strict');
const { DEFAULT_PRODUCTION_ORIGIN, parseAllowedOrigins, createCorsOptions } = require('../src/config/corsOptions');

test('production frontend is in the allowlist and configured origins are parsed', () => {
  const origins = parseAllowedOrigins('https://admin.example.com, https://preview.example.com ');
  assert.equal(origins.has(DEFAULT_PRODUCTION_ORIGIN), true);
  assert.equal(origins.has('https://admin.example.com'), true);
  assert.equal(origins.has('https://preview.example.com'), true);
});

test('CORS allows approved browser origins and non-browser clients', () => {
  const options = createCorsOptions(new Set([DEFAULT_PRODUCTION_ORIGIN]));
  for (const origin of [undefined, DEFAULT_PRODUCTION_ORIGIN]) {
    options.origin(origin, (error, allowed) => {
      assert.equal(error, null);
      assert.equal(allowed, true);
    });
  }
});

test('CORS rejects unknown browser origins', () => {
  const options = createCorsOptions(new Set([DEFAULT_PRODUCTION_ORIGIN]));
  options.origin('https://malicious.example', (error, allowed) => {
    assert.ok(error);
    assert.equal(error.status, 403);
    assert.equal(allowed, undefined);
  });
});
