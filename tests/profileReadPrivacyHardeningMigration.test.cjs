const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const migration = fs.readFileSync(
  path.join(__dirname, '../supabase/migrations/20261114120000_profile_read_privacy_hardening.sql'),
  'utf8',
);

test('broad authenticated profile visibility is replaced with relationship-scoped RLS', () => {
  assert.match(migration, /drop policy if exists "Profiles are viewable by any signed-in user"/i);
  assert.match(migration, /create policy "Users can view own and related profiles"/i);
  assert.match(migration, /id = \(select auth\.uid\(\)\)/i);
  assert.match(migration, /from public\.conversation_participants as viewer_membership/i);
  assert.match(migration, /from public\.messages as message_row/i);
  assert.match(migration, /from public\.call_sessions as cs/i);
  assert.match(migration, /from public\.status_updates as visible_status/i);
  assert.match(migration, /not exists \([\s\S]*?public\.blocked_users/i);
});

test('authenticated clients receive only the minimal direct profile projection', () => {
  assert.match(migration, /revoke select on table public\.profiles from public, anon, authenticated/i);
  assert.match(migration, /revoke select \(id, name, avatar_color, status, online, created_at, avatar_url, username\)/i);
  assert.match(migration, /grant select \(id, name, username, avatar_color\)[\s\S]*?to authenticated/i);
  assert.match(migration, /grant update \(username\)[\s\S]*?to authenticated/i);
});

test('full profile and conversation projections require authenticated scoped RPCs', () => {
  assert.match(migration, /create or replace function public\.get_my_profile\(\)/i);
  assert.match(migration, /where p\.id = auth\.uid\(\)/i);
  assert.match(migration, /create or replace function public\.get_conversation_profile_directory\(p_user_ids uuid\[\]\)/i);
  assert.match(migration, /p\.id = any\(coalesce\(p_user_ids, array\[\]::uuid\[\]\)\)/i);
  assert.match(migration, /grant execute on function public\.get_my_profile\(\) to authenticated/i);
  assert.match(migration, /grant execute on function public\.get_conversation_profile_directory\(uuid\[\]\) to authenticated/i);
});

test('public people search is bounded, visibility-aware, block-aware and rate-limited', () => {
  assert.match(migration, /create or replace function public\.search_people\([\s\S]*?p_query text,[\s\S]*?p_limit integer default 20/i);
  assert.match(migration, /people_search_limits/i);
  assert.match(migration, /v_request_count > 30/i);
  assert.match(migration, /limit greatest\(1, least\(coalesce\(p_limit, 20\), 25\)\)/i);
  assert.match(migration, /coalesce\(d\.profile_visibility, 'everyone'\) <> 'nobody'/i);
  assert.match(migration, /public\.blocked_users/i);
  assert.match(migration, /grant execute on function public\.search_people\(text, integer\) to authenticated/i);
});
