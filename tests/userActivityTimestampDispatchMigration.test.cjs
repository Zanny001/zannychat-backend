const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const assert = require('node:assert/strict');

const migrationPath = path.join(
  __dirname,
  '../supabase/migrations/20261116210000_fix_user_activity_timestamp_dispatch.sql'
);
const sql = fs.readFileSync(migrationPath, 'utf8');

test('timestamp dispatcher is pinned, invoker-only and transactionally replaced', () => {
  assert.match(sql, /begin;/i);
  assert.match(sql, /create or replace function private\.stamp_user_activity_timestamps\(\)/i);
  assert.match(sql, /security invoker/i);
  assert.match(sql, /set search_path = ''/i);
  assert.match(sql, /revoke all on function private\.stamp_user_activity_timestamps\(\)\s+from public, anon, authenticated/i);
  assert.match(sql, /commit;\s*$/i);
});

test('every attached activity table has an explicit timestamp dispatch branch', () => {
  const body = sql.slice(sql.indexOf('AS $function$'), sql.indexOf('$function$;')).toLowerCase();
  const expected = [
    'blocked_users', 'muted_status_users', 'reports', 'status_audience_recipients',
    'status_excluded_users', 'status_replies', 'message_reactions', 'status_views',
    'status_reactions', 'pinned_messages', 'conversation_participants', 'push_tokens',
    'user_presence_sessions', 'profile_details'
  ];
  for (const table of expected) {
    assert.ok(body.includes(table), table + ' has no timestamp dispatch branch');
  }
  assert.match(body, /new\.created_at := v_now/);
  assert.match(body, /new\.viewed_at := v_now/);
  assert.match(body, /new\.pinned_at := v_now/);
  assert.match(body, /new\.last_active_at := v_now/);
  assert.match(body, /unsupported activity timestamp trigger table/);
});

test('status reaction created_at is immutable on update and updated_at is refreshed', () => {
  const body = sql.slice(sql.indexOf('AS $function$'), sql.indexOf('$function$;')).toLowerCase();
  assert.match(body, /new\.created_at := old\.created_at/);
  assert.match(body, /new\.updated_at := v_now/);
});

test('explicit null last_read_at remains a supported unread reset', () => {
  const body = sql.slice(sql.indexOf('AS $function$'), sql.indexOf('$function$;')).toLowerCase();
  assert.match(body, /new\.last_read_at is not null and new\.last_read_at is distinct from old\.last_read_at/);
});

test('function rejects unexpected trigger tables instead of silently accepting them', () => {
  assert.match(sql, /raise exception 'unsupported activity timestamp trigger table: %'/i);
});
