const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const migration = fs.readFileSync(
  path.join(__dirname, '../supabase/migrations/20261110085000_allow_service_role_native_call_transitions.sql'),
  'utf8',
);

test('service-role native reconciliation is limited to signed terminal call transitions', () => {
  assert.match(migration, /auth\.role\(\) = 'service_role'/);
  assert.match(migration, /is_service_role AND NEW\.status = 'declined'/);
  assert.match(migration, /OLD\.status = 'accepted' AND NEW\.status = 'ended'[\s\S]*?OR is_service_role/);
  assert.match(migration, /OLD\.status = 'ringing' AND NEW\.status = 'missed'[\s\S]*?is_service_role/);
  assert.match(migration, /IF now\(\) < OLD\.expires_at THEN/);
  assert.match(migration, /call identity fields are immutable/);
  assert.match(migration, /invalid call state transition/);
});

const callsRoute = fs.readFileSync(path.join(__dirname, '../src/routes/calls.js'), 'utf8');

test('native event notifications use the status actually persisted by database triggers', () => {
  assert.match(callsRoute, /sendCallEndedToUser\(supabaseAdmin, call\.caller_id, callId, updated\.status\)/);
});
