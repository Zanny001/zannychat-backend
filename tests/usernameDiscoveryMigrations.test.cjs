const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const migrationsDir = path.join(__dirname, '..', 'supabase', 'migrations');
const usernames = fs.readFileSync(path.join(migrationsDir, '20261113123254_automatic_unique_usernames_for_all_auth_users.sql'), 'utf8');
const discovery = fs.readFileSync(path.join(migrationsDir, '20261113123303_privacy_aware_public_profile_search.sql'), 'utf8');

test('email and OAuth account creation provision usernames in the auth trigger', () => {
  assert.match(usernames, /create or replace function public\.handle_new_user\(\)/i);
  assert.match(usernames, /new\.raw_user_meta_data\s*->>\s*'name'/i);
  assert.match(usernames, /new\.raw_user_meta_data\s*->>\s*'full_name'/i);
  assert.match(usernames, /new\.raw_user_meta_data\s*->>\s*'display_name'/i);
  assert.match(usernames, /new\.id::text/i);
  assert.match(usernames, /insert into public\.profiles\s*\(id,\s*name,\s*username\)/i);
  assert.doesNotMatch(usernames, /new\.phone|new\.email\s*\|\|/i);
});

test('existing accounts are backfilled without changing account IDs and username becomes mandatory', () => {
  assert.match(usernames, /from public\.profiles p\s+join auth\.users u on u\.id = p\.id/i);
  assert.match(usernames, /where p\.username is null or btrim\(p\.username\) = ''/i);
  assert.match(usernames, /alter table public\.profiles alter column username set not null/i);
  assert.match(usernames, /username backfill incomplete/i);
  assert.doesNotMatch(usernames, /delete from public\.profiles|update public\.profiles\s+set\s+id/i);
});

test('people search is authenticated, bounded, and exposes only public directory fields', () => {
  assert.match(discovery, /create or replace function public\.search_public_profiles\(/i);
  assert.match(discovery, /returns table\s*\(\s*id uuid,\s*name text,\s*username text,\s*avatar_color text,\s*avatar_url text,\s*status text,\s*online boolean/is);
  assert.match(discovery, /security definer\s+set search_path = ''/i);
  assert.match(discovery, /raise exception 'Authentication required'/i);
  assert.match(discovery, /greatest\(1, least\(coalesce\(p_limit, 20\), 30\)\)/i);
  assert.match(discovery, /greatest\(0, least\(coalesce\(p_offset, 0\), 1000\)\)/i);
  const projection = discovery.match(/returns table\s*\(([\s\S]*?)\)\s*language/i)?.[1] || '';
  assert.doesNotMatch(projection, /email|phone|raw_user_meta_data/i);
  assert.match(discovery, /revoke all on function public\.search_public_profiles\(text, integer, integer\) from public/i);
  assert.match(discovery, /revoke all on function public\.search_public_profiles\(text, integer, integer\) from anon/i);
  assert.match(discovery, /grant execute on function public\.search_public_profiles\(text, integer, integer\) to authenticated/i);
});

test('people search respects profile visibility and bidirectional blocks', () => {
  assert.match(discovery, /coalesce\(d\.profile_visibility, 'everyone'\) <> 'nobody'/i);
  assert.match(discovery, /coalesce\(d\.profile_visibility, 'everyone'\) <> 'contacts'\s+or exists/i);
  assert.match(discovery, /mine\.user_id = v_viewer[\s\S]*theirs\.user_id = p\.id/i);
  assert.match(discovery, /b\.blocker_id = v_viewer and b\.blocked_id = p\.id/i);
  assert.match(discovery, /b\.blocker_id = p\.id and b\.blocked_id = v_viewer/i);
  assert.match(discovery, /public\.can_view_profile_avatar\(p\.id\)/i);
  assert.match(discovery, /coalesce\(d\.show_online_status, true\)/i);
  assert.match(discovery, /p\.id <> v_viewer/i);
});


test('username fallback never derives public identity from an email address', () => {
  const privacyFix = fs.readFileSync(
    path.join(migrationsDir, '20261113123708_remove_email_derived_username_fallback.sql'),
    'utf8',
  );
  const privacyStart = privacyFix.search(/create or replace function public\.handle_new_user\(\)/i);
  const privacyEnd = privacyFix.indexOf('$function$;', privacyStart);
  const privacyBody = privacyFix.slice(privacyStart, privacyEnd);
  assert.match(privacyBody, /'ZannyChat User'/i);
  assert.doesNotMatch(privacyBody, /new\.email|split_part/i);
  assert.match(privacyFix, /set username = 'zannyuser'/i);
});


test('QR profile lookup does not require a shared conversation and enforces privacy', () => {
  const qrLookup = fs.readFileSync(
    path.join(migrationsDir, '20261113124306_public_profile_lookup_for_qr_contacts.sql'),
    'utf8',
  );
  assert.match(qrLookup, /create or replace function public\.get_public_profile_by_id\(p_user_id uuid\)/i);
  assert.match(qrLookup, /security definer\s+set search_path = ''/i);
  assert.match(qrLookup, /raise exception 'Authentication required'/i);
  assert.match(qrLookup, /coalesce\(d\.profile_visibility, 'everyone'\) <> 'nobody'/i);
  assert.match(qrLookup, /coalesce\(d\.profile_visibility, 'everyone'\) <> 'contacts'\s+or exists/i);
  assert.match(qrLookup, /conversation_participants mine[\s\S]*conversation_participants theirs/i);
  assert.match(qrLookup, /b\.blocker_id = v_viewer and b\.blocked_id = p\.id/i);
  assert.match(qrLookup, /b\.blocker_id = p\.id and b\.blocked_id = v_viewer/i);
  assert.match(qrLookup, /public\.can_view_profile_avatar\(p\.id\)/i);
  assert.match(qrLookup, /revoke all on function public\.get_public_profile_by_id\(uuid\) from anon/i);
  assert.match(qrLookup, /grant execute on function public\.get_public_profile_by_id\(uuid\) to authenticated/i);
  assert.doesNotMatch(qrLookup.match(/returns table\s*\(([\s\S]*?)\)\s*language/i)?.[1] || '', /email|phone/i);
});
