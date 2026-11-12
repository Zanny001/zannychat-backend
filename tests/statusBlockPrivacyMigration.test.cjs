const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const sql = fs.readFileSync(
  path.join(__dirname, '../supabase/migrations/20261112113113_enforce_bidirectional_block_status_visibility.sql'),
  'utf8'
);

test('status visibility remains a stable, pinned SECURITY DEFINER helper', () => {
  assert.match(sql, /create or replace function public\.can_view_status\(p_status_id uuid, p_viewer_id uuid\)/i);
  assert.match(sql, /language sql[\s\S]*stable[\s\S]*security definer/i);
  assert.match(sql, /set search_path to 'pg_catalog', 'public'/i);
  assert.doesNotMatch(sql, /\b(grant|revoke)\b/i);
});

test('either direction of a block denies non-owner status visibility', () => {
  assert.match(
    sql,
    /not exists\s*\(\s*select 1\s*from public\.blocked_users b\s*where\s*\(b\.blocker_id = s\.user_id and b\.blocked_id = p_viewer_id\)\s*or\s*\(b\.blocker_id = p_viewer_id and b\.blocked_id = s\.user_id\)/i
  );
  assert.match(sql, /s\.user_id = p_viewer_id\s+or\s*\(/i);
  assert.match(sql, /s\.user_id <> p_viewer_id/i);
});

test('existing expiry, exclusions, contacts and selected recipients remain enforced', () => {
  assert.match(sql, /s\.expires_at > now\(\)/i);
  assert.match(sql, /public\.status_excluded_users/i);
  assert.match(sql, /s\.audience = 'contacts'/i);
  assert.match(sql, /s\.audience = 'selected_contacts'/i);
  assert.match(sql, /public\.status_audience_recipients/i);
  assert.match(sql, /p_viewer_id = \(select auth\.uid\(\)\)/i);
});

test('migration is additive and changes only the centralized visibility function', () => {
  assert.equal((sql.match(/create or replace function/gi) || []).length, 1);
  assert.doesNotMatch(sql, /drop policy|create policy|alter table|drop table/i);
});
