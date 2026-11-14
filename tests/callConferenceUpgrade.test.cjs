const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const migration = fs.readFileSync(path.join(__dirname, '../supabase/migrations/20261114173000_call_conference_upgrade_and_invites.sql'), 'utf8');
const route = fs.readFileSync(path.join(__dirname, '../src/routes/groupCalls.js'), 'utf8');
const lifecycleMigration = fs.readFileSync(path.join(__dirname, '../supabase/migrations/20261114180000_call_conference_participant_end_hardening.sql'), 'utf8');
const triggerPrivilegeMigration = fs.readFileSync(path.join(__dirname, '../supabase/migrations/20261114183000_revoke_call_conference_trigger_execute.sql'), 'utf8');
const joinGuardsMigration = fs.readFileSync(path.join(__dirname, '../supabase/migrations/20261114190000_call_conference_join_guards.sql'), 'utf8');

test('direct calls can be atomically promoted to a private SFU conference', () => {
  assert.match(migration, /ADD COLUMN IF NOT EXISTS source_call_id uuid/);
  assert.match(migration, /ADD COLUMN IF NOT EXISTS group_room_id uuid/);
  assert.match(migration, /FUNCTION public\.promote_direct_call_to_group_room\(/);
  assert.match(migration, /v_call\.status <> 'accepted'/);
  assert.match(migration, /p_actor_user_id NOT IN \(v_call\.caller_id, v_call\.callee_id\)/);
  assert.match(migration, /COALESCE\(v_is_group, true\)/);
  assert.match(migration, /blocked_users/);
  assert.match(migration, /profile_visibility/);
  assert.match(migration, /INSERT INTO public\.group_call_rooms/);
  assert.match(migration, /INSERT INTO public\.group_call_participants/);
  assert.match(migration, /group_room_id = p_room_id/);
  assert.match(migration, /SET status = 'ended'/);
});

test('direct conference room links are service-role-only and must match the source call', () => {
  assert.match(migration, /FUNCTION public\.guard_call_session_group_room_link\(\)/);
  assert.match(migration, /auth\.role\(\) = 'service_role'/);
  assert.match(migration, /r\.source_call_id = OLD\.id/);
  assert.match(migration, /OLD\.status <> 'accepted' OR NEW\.status <> 'ended'/);
  assert.match(migration, /REVOKE ALL ON FUNCTION public\.promote_direct_call_to_group_room/);
  assert.match(migration, /TO service_role/);
});

test('direct conference admission requires a matching upgraded call and an active invitation', () => {
  assert.match(migration, /FUNCTION public\.join_direct_call_room\(/);
  assert.match(migration, /v_room\.source_call_id IS NULL/);
  assert.match(migration, /v_call\.group_room_id <> p_room_id/);
  assert.match(migration, /v_status IN \('declined','left'\)/);
  assert.match(migration, /interval '2 minutes'/);
  assert.match(migration, /conference call is full/);
  assert.match(migration, /TO service_role/);
});

test('group and direct conferences can invite more participants with capacity, privacy and block checks', () => {
  assert.match(migration, /FUNCTION public\.invite_group_call_participants\(/);
  assert.match(migration, /only the call host or a group admin can invite members/);
  assert.match(migration, /only the call host can invite conference participants/);
  assert.match(migration, /only group members can be invited to this call/);
  assert.match(migration, /blocked users cannot share a call/);
  assert.match(migration, /invitee is already in another call/);
  assert.match(migration, /max_participants = GREATEST/);
  assert.match(migration, /status = 'invited', invited_at = now\(\)/);
});

test('direct conference end is restricted to its host and tears down participant state', () => {
  assert.match(migration, /FUNCTION public\.end_direct_call_room\(/);
  assert.match(migration, /p_user_id <> v_room\.host_user_id/);
  assert.match(migration, /status = 'ended'/);
  assert.match(migration, /status = 'left'/);
  assert.match(migration, /TO service_role/);
});

test('backend exposes direct-call upgrade, invite, join and end routes with LiveKit tokens and push delivery', () => {
  assert.match(route, /router\.post\('\/upgrade\/:callId'/);
  assert.match(route, /rpc\('promote_direct_call_to_group_room_with_media'/);
  assert.match(route, /data: \{ type: 'group_call_invite', groupCallId: roomId/);
  assert.match(route, /rpc\('join_direct_call_room'/);
  assert.match(route, /router\.post\('\/:roomId\/invite'/);
  assert.match(route, /rpc\('invite_group_call_participants'/);
  assert.match(route, /rpc\('end_direct_call_room'/);
  assert.match(route, /cleanupEndedGroupCallMedia/);
});

test('promoted direct conferences preserve join duration and let either connected participant end', () => {
  assert.match(lifecycleMigration, /joined_at = COALESCE\(public\.group_call_participants\.joined_at, EXCLUDED\.joined_at\)/);
  assert.match(lifecycleMigration, /p\.user_id = p_user_id/);
  assert.match(lifecycleMigration, /p\.status = 'joined'/);
  assert.match(lifecycleMigration, /only a connected participant can end this conference/);
  assert.doesNotMatch(lifecycleMigration, /p_user_id <> v_room\.host_user_id/);
  assert.match(route, /Only a connected participant can end this conference/);
});

test('conference link trigger function is not exposed as an anonymous or authenticated RPC', () => {
  assert.match(triggerPrivilegeMigration, /REVOKE ALL ON FUNCTION public\.guard_call_session_group_room_link\(\) FROM PUBLIC, anon, authenticated/);
  assert.match(triggerPrivilegeMigration, /GRANT EXECUTE ON FUNCTION public\.guard_call_session_group_room_link\(\) TO service_role/);
});

test('conference admission rechecks blocks and active-call exclusivity at join time', () => {
  assert.match(joinGuardsMigration, /blocked_users/);
  assert.match(joinGuardsMigration, /blocked users cannot share a conference call/);
  assert.match(joinGuardsMigration, /call_sessions c/);
  assert.match(joinGuardsMigration, /group_call_rooms r/);
  assert.match(joinGuardsMigration, /user is already in another call/);
  assert.match(joinGuardsMigration, /REVOKE ALL ON FUNCTION public\.join_direct_call_room\(uuid, uuid\) FROM PUBLIC, anon, authenticated/);
  assert.match(joinGuardsMigration, /GRANT EXECUTE ON FUNCTION public\.join_direct_call_room\(uuid, uuid\) TO service_role/);
});

test('only joined call participants can read the current room roster', () => {
  assert.match(route, /router\.get\('\/:roomId\/participants'/);
  assert.match(route, /Only connected call participants can view the room roster/);
  assert.match(route, /\.eq\('status', 'joined'\)/);
  assert.match(route, /participantIds:/);
});
