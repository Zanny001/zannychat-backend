const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const sql = fs.readFileSync(path.join(__dirname, '../supabase/migrations/0017_polls.sql'), 'utf8');
test('poll schema constrains question and option lengths/count positions', () => {
  assert.match(sql, /char_length\(btrim\(question\)\) between 1 and 240/i);
  assert.match(sql, /char_length\(btrim\(label\)\) between 1 and 120/i);
  assert.match(sql, /position between 0 and 9/i);
});
test('poll tables enforce membership, voter identity, and one vote per user per poll', () => {
  assert.match(sql, /primary key \(poll_id, user_id\)/i);
  assert.match(sql, /creator_id = \(select auth\.uid\(\)\)/i);
  assert.match(sql, /user_id = \(select auth\.uid\(\)\)/i);
  assert.match(sql, /conversation_participants/i);
});
test('poll votes validate option belongs to poll and prevent voting after close', () => {
  assert.match(sql, /o\.poll_id = poll_votes\.poll_id/i);
  assert.match(sql, /p\.closes_at is null or p\.closes_at > now\(\)/i);
});
test('poll data is not available to anonymous clients', () => {
  assert.match(sql, /revoke all on public\.polls, public\.poll_options, public\.poll_votes from anon/i);
});
