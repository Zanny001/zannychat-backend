const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const sql = fs.readFileSync(path.join(__dirname, '../supabase/migrations/20261110192943_profile_privacy_and_attachment_cleanup_0066.sql'), 'utf8');

test('profile details are owner-private and public projection filters fields by visibility', () => {
  assert.match(sql, /create table if not exists public\.profile_details/);
  assert.match(sql, /using \(user_id = auth\.uid\(\)\) with check \(user_id = auth\.uid\(\)\)/);
  assert.match(sql, /create or replace function public\.get_public_profile_details/);
  assert.match(sql, /v_details\.show_location/);
  assert.match(sql, /v_details\.show_birthday/);
  assert.match(sql, /v_details\.profile_visibility = 'nobody'/);
  assert.match(sql, /public\.blocked_users/);
  assert.match(sql, /profiles_username_lower_unique/);
});

test('call recipient privacy is enforced in a database trigger', () => {
  assert.match(sql, /create or replace function public\.enforce_call_recipient_privacy/);
  assert.match(sql, /v_permission = 'nobody'/);
  assert.match(sql, /v_permission = 'contacts' and not v_is_contact/);
  assert.match(sql, /before insert on public\.call_sessions/);
});
