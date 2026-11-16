const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const assert = require('node:assert/strict');

const migrationPath = path.join(
  __dirname,
  '../supabase/migrations/20261116223000_guard_user_activity_server_timestamps.sql'
);
const sql = fs.readFileSync(migrationPath, 'utf8');

test('activity timestamp migration is transactional and uses an invoker-only pinned function', () => {
  assert.match(sql, /^--[\s\S]*?begin;/i);
  assert.match(sql, /create or replace function private\.stamp_user_activity_timestamps\(\)/i);
  assert.match(sql, /security invoker/i);
  assert.match(sql, /set search_path = ''/i);
  assert.match(sql, /revoke all on function private\.stamp_user_activity_timestamps\(\)\s+from public, anon, authenticated/i);
  assert.match(sql, /commit;\s*$/i);
});

test('all client-writable activity timestamps are stamped from database time', () => {
  for (const field of ['viewed_at', 'created_at', 'updated_at', 'pinned_at', 'last_read_at', 'last_seen_at']) {
    assert.match(sql, new RegExp('new\\.' + field + '\\s*:=\\s*v_now', 'i'), field + ' must be server stamped');
  }
  assert.match(sql, /pg_catalog\.clock_timestamp\(\)/i);
});

test('reaction creation time cannot be rewritten and update time is refreshed', () => {
  assert.match(sql, /new\.created_at := old\.created_at/i);
  assert.match(sql, /new\.updated_at := v_now/i);
});

test('all seven activity tables receive narrowly scoped triggers', () => {
  const expected = [
    'status_views', 'status_replies', 'message_reactions', 'status_reactions',
    'pinned_messages', 'conversation_participants', 'profile_details'
  ];
  for (const table of expected) {
    assert.match(sql, new RegExp('create trigger [a-z_]+[\\s\\S]{0,160}on public\\.' + table, 'i'), table + ' trigger missing');
  }
  assert.doesNotMatch(sql, /create policy|drop policy|grant .*public\.|revoke .*public\./i);
});

test('read cursor trigger only fires when last_read_at is updated', () => {
  assert.match(sql, /before update of last_read_at on public\.conversation_participants/i);
});

test('existing profile visibility and pinned snapshot triggers are not removed', () => {
  assert.doesNotMatch(sql, /drop trigger[^;]*(profile_details_visibility_guard|pinned_message_snapshot_before_insert)/i);
});
