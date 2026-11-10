const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const sql = fs.readFileSync(path.join(__dirname, '../supabase/migrations/20261110193010_presence_and_read_receipt_projection_0070.sql'), 'utf8');

test('presence is owner-written and server-filtered by contacts, blocks and independent privacy flags', () => {
  assert.match(sql, /create table if not exists public\.user_presence_sessions/);
  assert.match(sql, /using \(user_id = \(select auth\.uid\(\)\)\)/);
  assert.match(sql, /function public\.heartbeat_presence/);
  assert.match(sql, /function public\.get_visible_presence/);
  assert.match(sql, /s\.last_active_at >= now\(\) - interval '90 seconds'/);
  assert.match(sql, /d\.show_online_status/);
  assert.match(sql, /d\.show_last_seen/);
  assert.match(sql, /public\.blocked_users/);
  assert.match(sql, /join public\.conversation_participants mine/);
});

test('read receipts have a dedicated privacy-filtered projection without deleting membership rows', () => {
  assert.match(sql, /function public\.get_conversation_read_state/);
  assert.match(sql, /private\.is_conversation_participant\(p_conversation_id\)/);
  assert.match(sql, /coalesce\(d\.show_read_receipts, true\)/);
  assert.match(sql, /then cp\.last_read_at else null end/);
  assert.doesNotMatch(sql, /drop table|truncate table|delete from public\.conversation_participants/i);
});
