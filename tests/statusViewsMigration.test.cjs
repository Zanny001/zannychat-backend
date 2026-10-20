const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const migration = fs.readFileSync(path.join(__dirname, '../supabase/migrations/0023_status_view_receipts.sql'), 'utf8');

test('status views are unique per status and viewer', () => {
  assert.match(migration, /primary key\s*\(status_id, viewer_id\)/i);
  assert.match(migration, /references public\.status_updates\(id\) on delete cascade/i);
});
test('only status owners can read view receipts', () => {
  assert.match(migration, /Status owner can read view receipts[\s\S]*?for select to authenticated using/i);
  assert.match(migration, /s\.user_id = \(select auth\.uid\(\)\)/i);
});
test('viewers can only insert receipts for themselves and visible active statuses', () => {
  assert.match(migration, /Eligible viewers can record own view[\s\S]*?for insert to authenticated with check/i);
  assert.match(migration, /viewer_id = \(select auth\.uid\(\)\)/i);
  assert.match(migration, /s\.user_id <> \(select auth\.uid\(\)\) and s\.expires_at > now\(\)/i);
});
test('anonymous access is revoked', () => {
  assert.match(migration, /revoke all on public\.status_views from anon/i);
});

test('view receipts require contact visibility, not merely a known status ID', () => {
  assert.match(migration, /s\.audience = 'contacts'/i);
  assert.match(migration, /join public\.conversation_participants theirs on theirs\.conversation_id = mine\.conversation_id/i);
});
