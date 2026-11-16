const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const migration = fs.readFileSync(path.join(__dirname, '../supabase/migrations/20261114193400_preserve_direct_call_media_mode_on_upgrade_20261114201000.sql'), 'utf8');
const route = fs.readFileSync(path.join(__dirname, '../src/routes/groupCalls.js'), 'utf8');

test('conference promotion wrapper validates media mode and reuses atomic participant authorization', () => {
  assert.match(migration, /FUNCTION public\.promote_direct_call_to_group_room_with_media\(/);
  assert.match(migration, /p_call_type NOT IN \('audio', 'video'\)/);
  assert.match(migration, /public\.promote_direct_call_to_group_room\(/);
  assert.match(migration, /SET call_type = p_call_type/);
  assert.match(migration, /source_call_id = p_call_id/);
  assert.match(migration, /host_user_id = p_actor_user_id/);
  assert.match(migration, /SET search_path = ''/);
});

test('conference media wrapper is executable only by the backend service role', () => {
  assert.match(migration, /REVOKE ALL ON FUNCTION public\.promote_direct_call_to_group_room_with_media/);
  assert.match(migration, /GRANT EXECUTE ON FUNCTION public\.promote_direct_call_to_group_room_with_media[\s\S]*TO service_role/);
  assert.doesNotMatch(migration, /GRANT EXECUTE ON FUNCTION public\.promote_direct_call_to_group_room_with_media[\s\S]*TO authenticated/);
});

test('direct-call upgrade uses the caller current audio/video mode for the room and invite notification', () => {
  assert.match(route, /const requestedCallType = req\.body\?\.callType/);
  assert.match(route, /Choose a valid call media type/);
  assert.match(route, /const mediaCallType = requestedCallType \|\| call\.call_type/);
  assert.match(route, /rpc\('promote_direct_call_to_group_room_with_media'/);
  assert.match(route, /p_call_type: mediaCallType/);
  assert.match(route, /title: mediaCallType === 'video'/);
  assert.match(route, /callType: mediaCallType/);
});
