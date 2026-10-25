const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const source = fs.readFileSync(path.join(__dirname, '..', 'src', 'index.js'), 'utf8');

test('API disables Express fingerprinting and applies conservative security headers', () => {
  assert.match(source, /app\.disable\('x-powered-by'\)/);
  for (const header of [
    'X-Content-Type-Options',
    'X-Frame-Options',
    'Referrer-Policy',
    'Cache-Control',
    'Permissions-Policy',
  ]) {
    assert.ok(source.includes(`'${header}'`), `missing ${header}`);
  }
  assert.match(source, /res\.setHeader\('X-Content-Type-Options', 'nosniff'\)/);
  assert.match(source, /res\.setHeader\('X-Frame-Options', 'DENY'\)/);
  assert.match(source, /res\.setHeader\('Referrer-Policy', 'no-referrer'\)/);
  assert.match(source, /res\.setHeader\('Cache-Control', 'no-store'\)/);
  assert.match(source, /res\.setHeader\('Strict-Transport-Security', 'max-age=31536000'\)/);
  assert.match(source, /if \(process\.env\.NODE_ENV === 'production'\)/);
});
