const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const sql = fs.readFileSync(path.join(__dirname, '../supabase/migrations/0018_conversation_events.sql'), 'utf8');
test('event schema constrains titles, descriptions, location, and RSVP choices', () => {
  assert.match(sql, /char_length\(btrim\(title\)\) between 1 and 160/i);
  assert.match(sql, /char_length\(description\) <= 1000/i);
  assert.match(sql, /response in \('going','maybe','not_going'\)/i);
});
test('event reads and RSVP writes require conversation membership', () => {
  assert.match(sql, /conversation_participants/i);
  assert.match(sql, /cp\.user_id=auth\.uid\(\)/i);
  assert.match(sql, /revoke all on public\.conversation_events, public\.conversation_event_rsvps from anon/i);
});
test('event creation requires a future start time and RSVP is upserted per user', () => {
  assert.match(sql, /p_starts_at <= now\(\)/i);
  assert.match(sql, /primary key \(event_id, user_id\)/i);
  assert.match(sql, /on conflict\(event_id,user_id\) do update/i);
  assert.match(sql, /p_response not in \('going','maybe','not_going'\)/i);
});


test('LIVE Event invite and reminder user foreign keys have supporting leading-column indexes', () => {
  const migration = fs.readFileSync(path.join(__dirname, '../supabase/migrations/20261120130000_index_live_event_foreign_keys.sql'), 'utf8');
  assert.match(migration, /CREATE INDEX IF NOT EXISTS live_event_invites_invited_by_idx\s+ON public\.live_event_invites \(invited_by\)/i);
  assert.match(migration, /CREATE INDEX IF NOT EXISTS live_event_reminder_deliveries_user_id_idx\s+ON public\.live_event_reminder_deliveries \(user_id\)/i);
});
