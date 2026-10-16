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
