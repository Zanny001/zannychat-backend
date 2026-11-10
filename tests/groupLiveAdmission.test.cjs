const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const migration = fs.readFileSync(path.join(__dirname, '../supabase/migrations/20261110070203_atomic_group_live_admission.sql'), 'utf8');
const expiryMigration = fs.readFileSync(path.join(__dirname, '../supabase/migrations/20261110180000_expire_group_call_invitations.sql'), 'utf8');
const groupRoute = fs.readFileSync(path.join(__dirname, '../src/routes/groupCalls.js'), 'utf8');
const liveRoute = fs.readFileSync(path.join(__dirname, '../src/routes/liveStreams.js'), 'utf8');

test('group-call admission locks the room row and enforces membership and participant capacity', () => {
  assert.ok(migration.includes('FUNCTION public.join_group_call_room(p_room_id uuid, p_user_id uuid)'));
  assert.ok(migration.includes('FROM public.group_call_rooms'));
  assert.ok(migration.includes('FOR UPDATE'));
  assert.ok(migration.includes('c.is_group = true'));
  assert.ok(migration.includes('v_joined >= v_room.max_participants'));
  assert.ok(migration.includes('TO service_role'));
  assert.ok(groupRoute.includes("rpc('join_group_call_room'"));
});

test('unanswered group-call invitations expire without ending the active room', () => {
  assert.ok(expiryMigration.includes("v_existing_status = 'invited'"));
  assert.ok(expiryMigration.includes("v_invited_at <= now() - interval '2 minutes'"));
  assert.ok(expiryMigration.includes("RAISE EXCEPTION 'group call invitation has expired'"));
  assert.ok(expiryMigration.includes('FOR UPDATE'));
  assert.ok(expiryMigration.includes("v_room.status NOT IN ('ringing','active')"));
  assert.ok(expiryMigration.includes('GRANT EXECUTE ON FUNCTION public.join_group_call_room(uuid, uuid) TO service_role'));
});

test('LIVE audience admission locks the stream row and enforces visibility and viewer capacity', () => {
  assert.ok(migration.includes('FUNCTION public.join_live_stream(p_stream_id uuid, p_user_id uuid)'));
  assert.ok(migration.includes("v_stream.visibility <> 'public'"));
  assert.ok(migration.includes('v_joined >= v_stream.viewer_limit'));
  assert.ok(liveRoute.includes("rpc('join_live_stream'"));
});

test('only the creator can hide LIVE comments', () => {
  assert.ok(liveRoute.includes("router.post('/:streamId/comments/:commentId/hide'"));
  assert.ok(liveRoute.includes('stream.creator_id !== req.user.id'));
  assert.ok(liveRoute.includes("update({ moderation_status: 'hidden' })"));
});
