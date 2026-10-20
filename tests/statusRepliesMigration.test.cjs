const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const sql = fs.readFileSync(path.join(__dirname, '../supabase/migrations/0025_status_replies.sql'), 'utf8');
test('status replies are tied to statuses and authenticated profiles', () => {
  assert.match(sql, /status_id uuid not null references public\.status_updates\(id\) on delete cascade/i);
  assert.match(sql, /sender_id uuid not null references public\.profiles\(id\) on delete cascade/i);
  assert.match(sql, /char_length\(trim\(body\)\) between 1 and 1000/i);
});
test('only status owners and senders can read replies while status is active', () => {
  assert.match(sql, /s\.expires_at > now\(\)/i);
  assert.match(sql, /s\.user_id = \(select auth\.uid\(\)\) or status_replies\.sender_id = \(select auth\.uid\(\)\)/i);
});
test('reply creation requires eligible contact visibility and own sender identity', () => {
  assert.match(sql, /sender_id = \(select auth\.uid\(\)\)/i);
  assert.match(sql, /s\.audience = 'contacts'/i);
  assert.match(sql, /conversation_participants mine join public\.conversation_participants theirs/i);
});
test('anonymous access and update/delete grants are absent', () => {
  assert.match(sql, /revoke all on public\.status_replies from anon/i);
  assert.match(sql, /grant select, insert on public\.status_replies to authenticated/i);
  assert.doesNotMatch(sql, /grant .*update|grant .*delete/i);
});
