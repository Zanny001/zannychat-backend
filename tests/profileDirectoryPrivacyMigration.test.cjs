const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const sql = fs.readFileSync(path.join(__dirname, '../supabase/migrations/20261110193003_privacy_aware_profile_discovery_0069.sql'), 'utf8');

test('profile discovery only creates the legacy projection when no function signature exists', () => {
  assert.match(sql, /if to_regprocedure\('public\.get_contact_directory\(uuid\)'\) is null then/i);
  assert.match(sql, /create function public\.get_contact_directory\(p_user_id uuid default null\)/i);
  assert.match(sql, /returns table\s*\(\s*id uuid,\s*name text,\s*avatar_color text,\s*username text/is);
  assert.match(sql, /security definer\s+set search_path = ''/i);
  assert.match(sql, /raise exception 'Authentication required'/i);
  assert.match(sql, /revoke all on function public\.get_contact_directory\(uuid\) from public, anon/i);
  assert.match(sql, /grant execute on function public\.get_contact_directory\(uuid\) to authenticated/i);
});

test('profile discovery enforces visibility, existing-contact scope, and blocks in both directions', () => {
  assert.match(sql, /coalesce\(d\.profile_visibility, 'everyone'\) <> 'nobody'/i);
  assert.match(sql, /coalesce\(d\.profile_visibility, 'everyone'\) = 'everyone'/i);
  assert.match(sql, /join\s+public\.conversation_participants(?:\s+as)?\s+theirs/i);
  assert.match(sql, /b\.blocker_id = v_viewer and b\.blocked_id = p\.id/i);
  assert.match(sql, /b\.blocker_id = p\.id and b\.blocked_id = v_viewer/i);
  assert.match(sql, /p\.id <> v_viewer/i);
});
