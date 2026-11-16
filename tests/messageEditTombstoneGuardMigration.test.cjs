const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const assert = require('node:assert/strict');

const sql = fs.readFileSync(
  path.join(__dirname, '../supabase/migrations/20261116180139_guard_message_edit_tombstones.sql'),
  'utf8',
);

test('message edits are restricted to active messages in the sender’s conversation', () => {
  assert.match(sql, /drop policy if exists "Senders can edit or delete their own messages"/i);
  assert.match(sql, /create policy "Senders can edit active messages in their conversations"/i);
  assert.match(sql, /for update\s+to authenticated/i);
  assert.match(sql, /using\s*\([\s\S]*sender_id = \(select auth\.uid\(\)\)[\s\S]*deleted_at is null[\s\S]*private\.is_conversation_member\(conversation_id\)/i);
  assert.match(sql, /with check\s*\([\s\S]*sender_id = \(select auth\.uid\(\)\)[\s\S]*deleted_at is null[\s\S]*private\.is_conversation_member\(conversation_id\)/i);
});

test('database guard prevents retracted-message resurrection and client-forged edit timestamps', () => {
  assert.match(sql, /create or replace function private\.guard_message_edit_integrity\(\)/i);
  assert.match(sql, /security invoker/i);
  assert.match(sql, /set search_path = ''/i);
  assert.match(sql, /old\.deleted_at is not null[\s\S]*retracted messages cannot be edited/i);
  assert.match(sql, /new\.deleted_at is distinct from old\.deleted_at[\s\S]*must use the authorized deletion rpc/i);
  assert.match(sql, /new\.edited_at := pg_catalog\.clock_timestamp\(\)/i);
  assert.match(sql, /edit timestamps are managed by the database/i);
  assert.match(sql, /revoke all on function private\.guard_message_edit_integrity\(\) from public, anon, authenticated/i);
  assert.match(sql, /before update on public\.messages/i);
});
