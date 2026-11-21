const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const route = (name) => fs.readFileSync(path.join(__dirname, '..', 'src', 'routes', name), 'utf8');

test('safety route does not return raw database errors', () => {
  for (const name of ['safety.js']) {
    const source = route(name);
    assert.doesNotMatch(source, /res\.status\(500\)\.json\(\{\s*error:\s*(?:error|balanceError)\.message/);
    assert.match(source, /console\.error\(/);
  }
});

test('AI endpoints do not return raw provider errors or raw malformed payloads', () => {
  const source = route('ai.js');
  assert.doesNotMatch(source, /res\.status\(500\)\.json\(\{\s*error:\s*err\.message/);
  assert.doesNotMatch(source, /json\(\{\s*error:[^}]*,\s*raw\s*\}/);
});

test('internal notification and webhook verification errors are generic to callers', () => {
  assert.doesNotMatch(route('internal.js'), /res\.status\(500\)\.json\(\{\s*error:\s*err\.message/);
  assert.doesNotMatch(route('webhooks.js'), /signature verification failed:\s*\$\{err\.message\}/i);
});


test('client render diagnostics require authentication, are rate limited, and redact sensitive values', () => {
  const source = route('clientDiagnostics.js');
  const index = fs.readFileSync(path.join(__dirname, '..', 'src', 'index.js'), 'utf8');
  assert.match(source, /router\.use\(requireAuth, makeLimiter/);
  assert.match(source, /ALLOWED_SECTORS/);
  assert.match(source, /ALLOWED_ROUTES/);
  assert.match(source, /safeDiagnosticText/);
  assert.match(source, /Bearer\s+/);
  assert.match(source, /\[email\]/);
  assert.match(source, /\[id\]/);
  assert.match(source, /console\.error\('\[client-diagnostic\]'/);
  assert.match(index, /app\.use\('\/diagnostics', clientDiagnosticsRouter\)/);
  assert.doesNotMatch(source, /req\.user\.id/);
});
