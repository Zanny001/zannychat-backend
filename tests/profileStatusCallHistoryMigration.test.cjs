const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const assert = require('node:assert/strict');

const migration = fs.readFileSync(
  path.join(__dirname, '../supabase/migrations/20261110010238_profile_status_call_history.sql'),
  'utf8',
);

test('profile media prerequisites are created with owner-only metadata and private storage', () => {
  assert.match(migration, /CREATE TABLE IF NOT EXISTS public\.profile_details/);
  assert.match(migration, /CREATE POLICY "Owners manage their private profile details"/);
  assert.match(migration, /'private-avatars', 'private-avatars', false/);
  assert.match(migration, /public\.can_view_profile_avatar/);
  assert.match(migration, /get_visible_profile_avatar_path/);
  assert.match(migration, /get_visible_profile_cover_path/);
});

test('status creation uses database timestamps and a constrained expiry', () => {
  assert.match(migration, /CREATE OR REPLACE FUNCTION public\.create_status_update/);
  assert.match(migration, /SECURITY INVOKER/);
  assert.match(migration, /v_created timestamptz := pg_catalog\.now\(\)/);
  assert.match(migration, /v_hours NOT IN \(6, 12, 24, 48\)/);
  assert.match(migration, /v_created \+ pg_catalog\.make_interval/);
});

test('expired call invitations become missed and participant history is retained', () => {
  assert.match(migration, /NEW\.status = 'missed'/);
  assert.match(migration, /call invitation has not expired/);
  assert.match(migration, /SET status = 'missed', ended_at = now\(\)/);
  assert.match(migration, /Do not delete call_sessions/);
  const cleanup = migration.slice(migration.indexOf('CREATE OR REPLACE FUNCTION public.cleanup_stale_call_signals'));
  assert.doesNotMatch(cleanup, /DELETE FROM public\.call_sessions/);
});
