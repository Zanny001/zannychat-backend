const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const optIn = fs.readFileSync(path.join(__dirname, '../supabase/migrations/20261115014926_media_heartbeat_opt_in.sql'), 'utf8');
const lease = fs.readFileSync(path.join(__dirname, '../supabase/migrations/20261115014920_media_participant_heartbeat_leases.sql'), 'utf8');
const liveRoute = fs.readFileSync(path.join(__dirname, '../src/routes/liveStreams.js'), 'utf8');
const groupRoute = fs.readFileSync(path.join(__dirname, '../src/routes/groupCalls.js'), 'utf8');

test('heartbeat leases are opt-in so legacy web and APK clients are not expired', () => {
  assert.ok(optIn.includes('ALTER COLUMN last_seen_at DROP NOT NULL'));
  assert.ok(optIn.includes('ALTER COLUMN last_seen_at DROP DEFAULT'));
  assert.ok(optIn.includes("UPDATE public.live_stream_participants SET last_seen_at = NULL WHERE status = 'joined'"));
  assert.ok(optIn.includes("UPDATE public.group_call_participants SET last_seen_at = NULL WHERE status = 'joined'"));
});

test('new LIVE and group-call joins stay untracked until the first connected-room heartbeat', () => {
  for (const name of ['join_group_call_room', 'join_direct_call_room', 'join_live_stream']) {
    const start = optIn.indexOf(`CREATE OR REPLACE FUNCTION public.${name}`);
    assert.ok(start >= 0, `missing ${name}`);
    const next = optIn.indexOf('CREATE OR REPLACE FUNCTION public.', start + 40);
    const fn = optIn.slice(start, next < 0 ? optIn.length : next);
    assert.ok(fn.includes('last_seen_at = NULL'));
    assert.ok(fn.includes('now(), NULL, NULL)'));
  }
});

test('lease cleanup naturally skips NULL last-seen values from legacy clients', () => {
  assert.ok(lease.includes('last_seen_at < p_stale_before'));
  assert.ok(!lease.includes('COALESCE(last_seen_at'));
});

test('only explicit heartbeat endpoints opt users into cleanup after media connection', () => {
  const liveJoinStart = liveRoute.indexOf("router.post('/:streamId/join'");
  const liveHeartbeatStart = liveRoute.indexOf("router.post('/:streamId/heartbeat'");
  const liveJoin = liveRoute.slice(liveJoinStart, liveHeartbeatStart);
  assert.ok(!liveJoin.includes('last_seen_at: new Date().toISOString()'));
  assert.ok(liveRoute.slice(liveHeartbeatStart).includes('update({ last_seen_at: now })'));
  const groupJoinStart = groupRoute.indexOf("router.post('/:roomId/join'");
  const groupHeartbeatStart = groupRoute.indexOf("router.post('/:roomId/heartbeat'");
  const groupJoin = groupRoute.slice(groupJoinStart, groupHeartbeatStart);
  assert.ok(!groupJoin.includes('last_seen_at: new Date().toISOString()'));
  assert.ok(groupRoute.slice(groupHeartbeatStart).includes('update({ last_seen_at: now.toISOString() })'));
});
