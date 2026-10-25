const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const sql = fs.readFileSync(path.join(__dirname, '../supabase/migrations/0046_server_enforced_status_expiry.sql'), 'utf8');

 test('database only accepts the four supported Status lifetimes', () => {
  assert.match(sql, /Status expiry must be 6, 12, 24, or 48 hours/i);
  for (const seconds of ['21600', '43200', '86400', '172800']) assert.ok(sql.includes(seconds), `missing ${seconds}-second option`);
});

test('client-provided timestamps are replaced with server time at insert', () => {
  assert.match(sql, /server_created_at := clock_timestamp\(\)/i);
  assert.match(sql, /new\.created_at := server_created_at/i);
  assert.match(sql, /new\.expires_at := server_created_at \+ make_interval/i);
  assert.match(sql, /before insert or update of created_at, expires_at/i);
});

test('published Status timestamps cannot be extended or rewritten later', () => {
  assert.match(sql, /new\.created_at is distinct from old\.created_at/i);
  assert.match(sql, /new\.expires_at is distinct from old\.expires_at/i);
  assert.match(sql, /Status creation and expiry timestamps cannot be changed after publishing/i);
});

test('status row constraint and RLS policies permit no more than 48 hours', () => {
  assert.match(sql, /expires_at <= created_at \+ interval '48 hours'/i);
  assert.match(sql, /create policy "Users can publish own statuses"[\s\S]*with check/i);
  assert.match(sql, /create policy "Users can update own media status path"[\s\S]*with check/i);
  assert.doesNotMatch(sql, /interval '24 hours'/i);
});
