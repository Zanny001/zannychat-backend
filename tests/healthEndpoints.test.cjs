const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const indexSource = fs.readFileSync(path.join(root, 'src/index.js'), 'utf8');
const healthSource = fs.readFileSync(path.join(root, 'src/routes/health.js'), 'utf8');

test('backend root advertises operational health endpoints without secrets', () => {
  assert.match(indexSource, /app\.get\('\/'/);
  assert.match(indexSource, /liveness: '\/health\/live'/);
  assert.match(indexSource, /readiness: '\/health\/ready'/);
  assert.doesNotMatch(indexSource, /SUPABASE_SERVICE_ROLE_KEY\s*[:=]\s*['"][^'"]+['"]/);
});

test('liveness endpoint does not depend on Supabase and readiness reports database reachability', () => {
  assert.match(healthSource, /router\.get\('\/live',\s*\(req, res\)\s*=>/);
  assert.match(healthSource, /router\.get\('\/ready',\s*async\s*\(req, res\)\s*=>/);
  assert.match(healthSource, /res\.status\(status\)\.json/);
  assert.match(healthSource, /status: reachable \? 'ready' : 'not_ready'/);
});

test('Supabase readiness probe uses a bounded timeout when supported by the client', () => {
  assert.match(healthSource, /HEALTH_QUERY_TIMEOUT_MS/);
  assert.match(healthSource, /AbortSignal\.timeout\(HEALTH_QUERY_TIMEOUT_MS\)/);
  assert.match(healthSource, /typeof query\.abortSignal === 'function'/);
});
