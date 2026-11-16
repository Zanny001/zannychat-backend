const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const route = fs.readFileSync(path.join(__dirname, '../src/routes/callHistory.js'), 'utf8');
const migration = fs.readFileSync(path.join(__dirname, '../supabase/migrations/20261114232044_call_history_user_hiding.sql'), 'utf8');

test('call history deletion verifies participant ownership for direct and group calls', () => {
  assert.match(route, /router\.delete\('\/:kind\/:callId'/);
  assert.match(route, /call_sessions/);
  assert.match(route, /group_call_participants/);
  assert.match(route, /req\.user\.id/);
});

test('call history deletion is private to one user and does not delete the call itself', () => {
  assert.match(route, /call_history_hidden/);
  assert.doesNotMatch(route, /from\('call_sessions'\)\.delete/);
  assert.match(migration, /PRIMARY KEY \(user_id, call_id, call_kind\)/);
  assert.match(migration, /REVOKE ALL ON public\.call_history_hidden FROM PUBLIC, anon, authenticated/);
});
