const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const migration = fs.readFileSync(
  path.join(__dirname, '../supabase/migrations/20261113123700_username_identity_and_people_search.sql'),
  'utf8',
);

test('existing profiles receive unique lowercase usernames before username becomes mandatory', () => {
  assert.match(migration, /left join auth\.users as u on u\.id = p\.id/i);
  assert.match(migration, /where p\.username is null or btrim\(p\.username\) = ''/i);
  assert.match(migration, /create unique index if not exists profiles_username_lower_unique[\s\S]*?lower\(username\)/i);
  assert.match(migration, /alter column username set not null/i);
  assert.match(migration, /check \(username ~ '\^\[a-z0-9_\]\{3,24\}\$'\)/i);
});

test('email and OAuth Auth inserts share the existing profile trigger and generate usernames', () => {
  assert.match(migration, /create or replace function public\.handle_new_user\(\)/i);
  assert.match(migration, /new\.raw_user_meta_data ->> 'name'/i);
  assert.match(migration, /new\.raw_user_meta_data ->> 'full_name'/i);
  assert.match(migration, /new\.raw_user_meta_data ->> 'display_name'/i);
  assert.match(migration, /split_part\(coalesce\(new\.email, ''\), '@', 1\)/i);
  assert.match(migration, /insert into public\.profiles \(id, name, username\)/i);
  assert.doesNotMatch(migration, /drop trigger[^;]*on_auth_user_created/i);
  assert.match(migration, /revoke all on function public\.handle_new_user\(\) from public, anon, authenticated/i);
});

test('people search requires authentication, is prefix-only, bounded, and rate-limited', () => {
  assert.match(migration, /create or replace function public\.search_people\([\s\S]*?p_query text,[\s\S]*?p_limit integer default 20/i);
  assert.match(migration, /v_viewer uuid := auth\.uid\(\)/i);
  assert.match(migration, /length\(v_query\) < 2 or pg_catalog\.length\(v_query\) > 40/i);
  assert.match(migration, /people_search_limits/i);
  assert.match(migration, /language plpgsql\\s+volatile\\s+security definer/i);
  assert.match(migration, /v_request_count > 30/i);
  assert.match(migration, /limit greatest\(1, least\(coalesce\(p_limit, 20\), 25\)\)/i);
  assert.match(migration, /lower\(p\.username\) like v_pattern/i);
  assert.match(migration, /lower\(p\.name\) like v_pattern/i);
  assert.match(migration, /grant execute on function public\.search_people\(text, integer\) to authenticated/i);
});

test('people search respects profile visibility, photo visibility and bidirectional blocks', () => {
  assert.match(migration, /coalesce\(d\.profile_visibility, 'everyone'\) <> 'nobody'/i);
  assert.match(migration, /coalesce\(d\.profile_visibility, 'everyone'\) = 'everyone'/i);
  assert.match(migration, /coalesce\(d\.profile_visibility, 'everyone'\) = 'contacts'/i);
  assert.match(migration, /coalesce\(d\.photo_visibility, 'everyone'\) = 'nobody' then null/i);
  assert.match(migration, /b\.blocker_id = v_viewer and b\.blocked_id = p\.id/i);
  assert.match(migration, /b\.blocker_id = p\.id and b\.blocked_id = v_viewer/i);
  assert.match(migration, /p\.id <> v_viewer/i);
});

test('contact and QR directory preserves shared-conversation privacy while exposing usernames', () => {
  assert.match(migration, /drop function if exists public\.get_contact_directory\(\)/i);
  assert.match(migration, /drop function if exists public\.get_contact_directory\(uuid\)/i);
  assert.match(migration, /returns table \([\s\S]*?id uuid,[\s\S]*?name text,[\s\S]*?username text/i);
  assert.match(migration, /viewer_membership\.user_id = auth\.uid\(\)/i);
  assert.match(migration, /target_membership\.user_id = p\.id/i);
  assert.match(migration, /grant execute on function public\.get_contact_directory\(uuid\) to authenticated, service_role/i);
  assert.match(migration, /notify pgrst, 'reload schema'/i);
});
