const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const migration = fs.readFileSync(path.join(__dirname, '../supabase/migrations/20261114194000_allow_bidirectional_call_renegotiation.sql'), 'utf8');

test('accepted 1:1 calls allow either authenticated participant to renegotiate media', () => {
  assert.match(migration, /c\.status <> 'accepted'/);
  assert.doesNotMatch(migration, /new\.sender_id <> c\.caller_id/);
  assert.doesNotMatch(migration, /new\.sender_id <> c\.callee_id/);
  assert.match(migration, /new\.signal_type NOT IN \('offer', 'answer', 'ice-candidate'\)/);
  assert.match(migration, /new\.sender_id = c\.caller_id AND new\.recipient_id = c\.callee_id/);
  assert.match(migration, /new\.sender_id = c\.callee_id AND new\.recipient_id = c\.caller_id/);
});

test('bidirectional renegotiation retains call expiry and per-sender signaling rate limits', () => {
  assert.match(migration, /interval '8 hours'/);
  assert.match(migration, /interval '1 minute'/);
  assert.match(migration, /recent_count >= 120/);
});
