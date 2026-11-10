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
  assert.match(callsRoute, /const recipientId = actorId === call\.caller_id \? call\.callee_id : call\.caller_id/);
  assert.match(callsRoute, /sendCallEndedToUser\(supabaseAdmin, recipientId, callId, updated\.status\)/);
});

test('service-role native reconciliation may persist caller cancellation without relaxing participant checks', () => {
  const cancellationMigration = fs.readFileSync(
    path.join(__dirname, '../supabase/migrations/20261110091000_allow_service_role_native_call_cancellation.sql'),
    'utf8',
  );
  assert.match(cancellationMigration, /OLD\.status = 'ringing' AND NEW\.status = 'cancelled'[\s\S]*?actor = OLD\.caller_id OR is_service_role/);
  assert.match(cancellationMigration, /call identity fields are immutable/);
  assert.match(cancellationMigration, /invalid call state transition/);
});

test('outgoing native event credentials can only be minted by the active call owner', () => {
  assert.match(callsRoute, /router\.post\('\/:callId\/native-event-token'/);
  assert.match(callsRoute, /call\.caller_id !== req\.user\.id/);
  assert.match(callsRoute, /createCallEventToken\(callId, Date\.now\(\), req\.user\.id\)/);
  assert.match(callsRoute, /actorId === call\.caller_id \? 'cancelled'/);
  assert.match(callsRoute, /actorId === call\.caller_id \? call\.callee_id : call\.caller_id/);
});
