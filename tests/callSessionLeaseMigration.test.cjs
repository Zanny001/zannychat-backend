const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const sql = fs.readFileSync(path.join(__dirname, '..', 'supabase', 'migrations', '0060_call_session_heartbeat_lease.sql'), 'utf8');

test('accepted calls use a bounded heartbeat lease and an authenticated RPC', () => {
  assert.match(sql, /add column if not exists last_activity_at timestamptz not null default now\(\)/);
  assert.match(sql, /function public\.heartbeat_call_session\(p_call_id uuid\)/);
  assert.match(sql, /grant execute on function public\.heartbeat_call_session\(uuid\) to authenticated/);
  assert.match(sql, /last_activity_at > now\(\) - interval '3 minutes'/);
  assert.match(sql, /revoke all on function public\.heartbeat_call_session\(uuid\) from public, anon/);
});

test('stale accepted calls neither block a new call nor accept new signaling', () => {
  assert.match(sql, /c\.last_activity_at > now\(\) - interval '3 minutes'/);
  assert.match(sql, /c\.last_activity_at < now\(\) - interval '3 minutes'/);
  assert.match(sql, /call session expired or participant unauthorized/);
});

test('heartbeat leases cannot be updated to a future timestamp or on non-accepted calls', () => {
  assert.match(sql, /old\.status <> 'accepted'/);
  assert.match(sql, /new\.last_activity_at > now\(\) \+ interval '10 seconds'/);
});

test('stale signaling is purged and terminal call rows receive bounded retention', () => {
  assert.match(sql, /function public\.cleanup_stale_call_signals\(\)/);
  assert.match(sql, /s\.created_at < now\(\) - interval '1 day'/);
  assert.match(sql, /ended_at < now\(\) - interval '30 days'/);
  assert.match(sql, /grant execute on function public\.cleanup_stale_call_signals\(\) to service_role/);
  assert.match(sql, /cron\.schedule\('zannychat-call-signal-retention'/);
});


test('all SECURITY DEFINER call-lease functions use an empty search_path', () => {
  const definitions = [...sql.matchAll(/create or replace function public\.[\s\S]*?\$\$/gi)].map(match => match[0]);
  const definerFunctions = definitions.filter(definition => /security definer/i.test(definition));
  assert.ok(definerFunctions.length >= 4, 'expected heartbeat, session trigger, signal trigger, and cleanup functions');
  for (const definition of definerFunctions) {
    assert.match(definition, /set search_path = ''/i, 'SECURITY DEFINER function must pin an empty search_path');
  }
});
