const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const migration = fs.readFileSync(
  path.join(__dirname, '../supabase/migrations/20261115085023_rate_limit_public_profile_search.sql'),
  'utf8',
);

test('legacy public-profile search shares the per-user people-search quota', () => {
  assert.match(migration, /create or replace function public\\.search_public_profiles/i);
  assert.match(migration, /language plpgsql\\s+volatile\\s+security definer/i);
  assert.match(migration, /insert into public\\.people_search_limits/i);
  assert.match(migration, /on conflict \\(user_id\\) do update/i);
  assert.match(migration, /v_request_count > 30/i);
  assert.match(migration, /people search rate limit exceeded/i);
});

test('profile search keeps authentication, visibility, block and avatar privacy checks', () => {
  assert.match(migration, /v_viewer uuid := auth\\.uid\\(\\)/i);
  assert.match(migration, /public\\.can_view_profile_avatar\\(p\\.id\\)/i);
  assert.match(migration, /profile_visibility/i);
  assert.match(migration, /blocked_users/i);
  assert.match(migration, /set search_path = ''/i);
});

test('profile search remains authenticated-only', () => {
  assert.match(migration, /revoke all on function public\\.search_public_profiles\\(text, integer, integer\\)\\s+from public, anon/i);
  assert.match(migration, /grant execute on function public\\.search_public_profiles\\(text, integer, integer\\)\\s+to authenticated/i);
});
