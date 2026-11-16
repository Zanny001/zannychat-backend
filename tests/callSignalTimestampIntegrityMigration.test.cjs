const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const assert = require('node:assert/strict');

const migrationPath = path.join(
  __dirname,
  '../supabase/migrations/20261116195939_guard_call_signal_server_timestamps.sql'
);
const sql = fs.readFileSync(migrationPath, 'utf8');

function functionBody(source) {
  const start = source.search(/create\s+or\s+replace\s+function\s+public\.validate_call_signal_insert\s*\(/i);
  assert.notEqual(start, -1, 'call signal trigger function must exist');
  const end = source.indexOf('$function$;', start);
  assert.notEqual(end, -1, 'call signal trigger function must terminate');
  return source.slice(start, end).toLowerCase();
}

test('call signal migration is transactional and replaces the existing trigger function', () => {
  assert.match(sql, /\bbegin;/i);
  assert.match(sql, /create\s+or\s+replace\s+function\s+public\.validate_call_signal_insert/i);
  assert.match(sql, /\bcommit;\s*$/i);
  assert.doesNotMatch(sql, /drop\s+trigger|create\s+trigger/i);
});

test('call signal creation time is stamped after locking and before rate-limit counting', () => {
  const body = functionBody(sql);
  assert.match(body, /new\.created_at := pg_catalog\.clock_timestamp\(\)/);
  assert.match(body, /created_at > new\.created_at - interval '1 minute'/);
  assert.ok(body.indexOf('new.created_at := pg_catalog.clock_timestamp()') < body.indexOf('select count(*)'));
  assert.match(body, /pg_advisory_xact_lock/);
});

test('call signal sender, participant, status and signal-type checks remain intact', () => {
  const body = functionBody(sql);
  assert.match(body, /auth\.uid\(\) is null or new\.sender_id <> auth\.uid\(\)/);
  assert.match(body, /c\.status <> 'accepted'/);
  assert.match(body, /new\.recipient_id = c\.callee_id/);
  assert.match(body, /new\.recipient_id = c\.caller_id/);
  assert.match(body, /new\.signal_type not in \('offer', 'answer', 'ice-candidate'\)/);
  assert.match(body, /recent_count >= 120/);
});

test('trigger function is search-path pinned and not directly executable by API roles', () => {
  const body = functionBody(sql);
  assert.match(body, /security definer/);
  assert.match(body, /set search_path = ''/);
  assert.match(sql, /revoke all on function public\.validate_call_signal_insert\(\)\s+from public, anon, authenticated/i);
  assert.doesNotMatch(sql, /grant execute/i);
});

test('migration does not change call_signals RLS policies or table grants', () => {
  assert.doesNotMatch(sql, /create\s+policy|drop\s+policy|grant\s+.*call_signals|revoke\s+.*call_signals/i);
});
