const test = require('node:test');
const assert = require('node:assert/strict');
const { DEFAULT_PRODUCTION_ORIGIN, parseAllowedOrigins, createCorsOptions } = require('../src/config/corsOptions');

test('production frontend is in the allowlist and configured origins are parsed', () => {
  const origins = parseAllowedOrigins('https://admin.example.com, https://preview.example.com ');
  assert.equal(DEFAULT_PRODUCTION_ORIGIN, 'https://zannychat.vercel.app');
  assert.equal(origins.has(DEFAULT_PRODUCTION_ORIGIN), true);
  assert.equal(origins.has('https://zannychat.netlify.app'), true);
  assert.equal(origins.has('https://zannychat-app.netlify.app'), true);
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


test('CORS preflight allows the Supabase apikey header used by browser clients', () => {
  const options = createCorsOptions(new Set([DEFAULT_PRODUCTION_ORIGIN]));
  assert.equal(options.allowedHeaders.includes('apikey'), true);
  assert.equal(options.methods.includes('OPTIONS'), true);
});


test('CORS_EXTRA_ORIGINS adds exact preview origins without replacing configured origins', () => {
  const previous = process.env.CORS_EXTRA_ORIGINS;
  process.env.CORS_EXTRA_ORIGINS = 'http://localhost:4173, http://127.0.0.1:4173';
  try {
    const origins = parseAllowedOrigins('https://existing.example');
    assert.equal(origins.has('http://localhost:4173'), true);
    assert.equal(origins.has('http://127.0.0.1:4173'), true);
    assert.equal(origins.has('https://existing.example'), true);
    assert.equal(origins.has('https://zannychat.vercel.app'), true);
  } finally {
    if (previous === undefined) delete process.env.CORS_EXTRA_ORIGINS;
    else process.env.CORS_EXTRA_ORIGINS = previous;
  }
});
