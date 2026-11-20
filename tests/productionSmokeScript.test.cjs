const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const source = fs.readFileSync(path.join(__dirname, '..', 'scripts', 'smoke-production.mjs'), 'utf8');

test('production smoke checks retry transient failures with bounded configuration', () => {
  assert.match(source, /SMOKE_ATTEMPTS/);
  assert.match(source, /Math\.min\(5/);
  assert.match(source, /SMOKE_TIMEOUT_MS/);
  assert.match(source, /AbortController/);
  assert.match(source, /RETRY/);
});

test('production readiness requires a positive Supabase reachability signal', () => {
  assert.match(source, /body\?\.status === 'ready' && body\?\.supabaseReachable === true/);
  assert.match(source, /Supabase readiness was not confirmed/);
});

test('production smoke script never sends credentials or mutating HTTP methods', () => {
  assert.doesNotMatch(source, /SUPABASE_SERVICE_ROLE_KEY|Authorization:\s*Bearer/);
  assert.doesNotMatch(source, /method:\s*['"](POST|PUT|PATCH|DELETE)['"]/i);
});

test('production smoke defaults to the canonical Render backend service', () => {
  assert.match(source, /https:\/\/zannychat-backend-1\.onrender\.com/);
  assert.doesNotMatch(source, /https:\/\/zannychat-backend\.onrender\.com/);
});


test('production smoke defaults to the verified Vercel frontend domain', () => {
  assert.match(source, /https:\/\/zannychat\.vercel\.app/);
  assert.doesNotMatch(source, /https:\/\/zannychat-app\.netlify\.app/);
  assert.doesNotMatch(source, /https:\/\/zannychat\.netlify\.app/);
});


test('manual production smoke workflow runs only the public read-only endpoint script', () => {
  const workflow = fs.readFileSync(path.join(__dirname, '..', '.github', 'workflows', 'production-smoke.yml'), 'utf8');
  assert.match(workflow, /workflow_dispatch:/);
  assert.match(workflow, /https:\/\/zannychat\.vercel\.app/);
  assert.match(workflow, /https:\/\/zannychat-backend-1\.onrender\.com/);
  assert.match(workflow, /node scripts\/smoke-production\.mjs/);
  assert.doesNotMatch(workflow, /SUPABASE_SERVICE_ROLE_KEY|Authorization:\s*Bearer|supabase db push|POST|PATCH|DELETE/);
});
