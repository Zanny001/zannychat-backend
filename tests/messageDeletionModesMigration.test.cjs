const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const assert = require('node:assert/strict');

const sql = fs.readFileSync(path.join(__dirname, '../supabase/migrations/0065_message_deletion_modes.sql'), 'utf8');

test('message deletion migration supports per-viewer hiding without deleting rows', () => {
  assert.match(sql, /create table if not exists public\.message_hidden_for/i);
  assert.match(sql, /primary key \(message_id, user_id\)/i);
  assert.match(sql, /not exists \([\s\S]*message_hidden_for[\s\S]*mh\.user_id = auth\.uid\(\)/i);
  assert.match(sql, /on conflict \(message_id, user_id\) do nothing/i);
});

test('global deletion is authenticated, participant-scoped, and sender-only', () => {
  assert.match(sql, /security definer/i);
  assert.match(sql, /set search_path = pg_catalog, public/i);
  assert.match(sql, /Only the sender can delete a message for everyone/i);
  assert.match(sql, /grant execute on function public\.delete_message\(uuid, text\) to authenticated/i);
  assert.match(sql, /revoke all on function public\.delete_message\(uuid, text\) from public, anon/i);
});

test('global deletion clears visible message and attachment payload while preserving tombstone', () => {
  assert.match(sql, /deleted_at = coalesce\(deleted_at, now\(\)\)/i);
  for (const column of ['text = \'\'', 'media_url = null', 'media_name = null', 'media_size = null', 'media_duration = null']) {
    assert.ok(sql.includes(column), `expected ${column}`);
  }
});
