const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const migration = fs.readFileSync(path.join(__dirname, '../supabase/migrations/0041_shared_pinned_messages.sql'), 'utf8');

test('shared pins are unique per conversation and message and cascade with source deletion', () => {
  assert.match(migration, /primary key\s*\(conversation_id,\s*message_id\)/i);
  assert.match(migration, /references public\.conversations\(id\) on delete cascade/i);
  assert.match(migration, /references public\.messages\(id\) on delete cascade/i);
});
test('shared pin policies require conversation membership and authenticated pinner identity', () => {
  assert.match(migration, /pinned_by = auth\.uid\(\)/i);
  assert.match(migration, /conversation_participants cp[\s\S]*cp\.user_id = auth\.uid\(\)/i);
  assert.match(migration, /for select to authenticated/i);
  assert.match(migration, /for insert to authenticated with check/i);
});
test('only original pinner or group admin can remove a shared pin', () => {
  assert.match(migration, /pinned_by = auth\.uid\(\)[\s\S]*or exists/i);
  assert.match(migration, /cp\.is_admin = true/i);
});
test('snapshot fields have explicit length bounds and direct anonymous access is revoked', () => {
  assert.match(migration, /char_length\(message_text\) <= 20000/i);
  assert.match(migration, /char_length\(conversation_name\) <= 160/i);
  assert.match(migration, /revoke all on public\.pinned_messages from anon, authenticated/i);
});
test('stored message text and timestamp are taken from the source message, not trusted client input', () => {
  assert.match(migration, /create or replace function public\.set_pinned_message_snapshot/i);
  assert.match(migration, /new\.message_text := left\(coalesce\(source_message\.text, ''\), 20000\)/i);
  assert.match(migration, /new\.message_created_at := source_message\.created_at/i);
  assert.match(migration, /before insert on public\.pinned_messages/i);
});
