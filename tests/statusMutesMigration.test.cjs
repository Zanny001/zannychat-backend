const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const sql = fs.readFileSync(path.join(__dirname, '../supabase/migrations/0028_muted_status_users.sql'), 'utf8');
test('status mute table is user-scoped and prevents self-muting', () => {
  assert.match(sql, /primary key \(user_id, muted_user_id\)/i);
  assert.match(sql, /user_id <> muted_user_id/i);
  assert.match(sql, /enable row level security/i);
  assert.match(sql, /using \(user_id = \(select auth\.uid\(\)\)\)/i);
  assert.match(sql, /revoke all on public\.muted_status_users from anon, authenticated/i);
});
