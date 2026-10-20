const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const sql = fs.readFileSync(path.join(__dirname, '../supabase/migrations/0026_status_expiry_cleanup.sql'), 'utf8');

test('expired-status cleanup only broadens owner reads', () => {
  assert.match(sql, /drop policy if exists "Status author can read own updates"/i);
  assert.match(sql, /for select to authenticated using \(user_id = \(select auth\.uid\(\)\)\)/i);
  assert.doesNotMatch(sql, /to anon/i);
});
