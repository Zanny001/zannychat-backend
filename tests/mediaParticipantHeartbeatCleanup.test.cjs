const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const migration = fs.readFileSync(path.join(__dirname, '../supabase/migrations/20261115090002_media_participant_heartbeat_leases.sql'), 'utf8');
const worker = require('../src/jobs/mediaParticipantHeartbeatCleanup');
const roomAdmin = require('../src/services/livekitRoomAdmin');
const groupRoute = fs.readFileSync(path.join(__dirname, '../src/routes/groupCalls.js'), 'utf8');
const liveRoute = fs.readFileSync(path.join(__dirname, '../src/routes/liveStreams.js'), 'utf8');
const index = fs.readFileSync(path.join(__dirname, '../src/index.js'), 'utf8');
const replayWorker = fs.readFileSync(path.join(__dirname, '../src/jobs/liveReplayWorker.js'), 'utf8');

test('media participant cleanup invokes the service-role database lease cleanup with a bounded cutoff', async () => {
  let invocation;
  const result = await worker.cleanupStaleMediaParticipants({
    admin: { rpc: async (name, args) => {
      invocation = { name, args };
      return { data: { liveStreamsEnded: 1, liveParticipantsLeft: 2, groupParticipantsLeft: 3, groupRoomsEnded: 1 }, error: null };
    } },
    now: Date.parse('2026-11-15T01:00:00.000Z'),
    staleAfterMs: 180_000,
  });
  assert.equal(invocation.name, 'cleanup_stale_media_participants');
  assert.equal(invocation.args.p_stale_before, '2026-11-15T00:57:00.000Z');
  assert.deepEqual(result, {
    staleBefore: '2026-11-15T00:57:00.000Z',
    liveStreamsEnded: 1,
    liveParticipantsLeft: 2,
    groupParticipantsLeft: 3,
    groupRoomsEnded: 1,
  });
});

test('heartbeat schema is indexed and service-only cleanup is pinned to an empty search path', () => {
  assert.ok(migration.includes('live_stream_participants'));
  assert.ok(migration.includes('group_call_participants'));
  assert.ok(migration.includes('ADD COLUMN IF NOT EXISTS last_seen_at timestamptz NOT NULL DEFAULT now()'));
  assert.ok(migration.includes('live_stream_participants_active_heartbeat_idx'));
  assert.ok(migration.includes('group_call_participants_active_heartbeat_idx'));
  assert.ok(migration.includes('CREATE OR REPLACE FUNCTION public.cleanup_stale_media_participants'));
  assert.ok(migration.includes('SET search_path TO'));
  assert.ok(migration.includes('REVOKE ALL ON FUNCTION public.cleanup_stale_media_participants(timestamptz) FROM PUBLIC, anon, authenticated'));
  assert.ok(migration.includes('GRANT EXECUTE ON FUNCTION public.cleanup_stale_media_participants(timestamptz) TO service_role'));
});

test('group and direct conference joins re-check blocks and permit only stale-disconnect rejoin', () => {
  assert.ok(migration.includes('CREATE OR REPLACE FUNCTION public.join_group_call_room'));
  assert.ok(migration.includes('CREATE OR REPLACE FUNCTION public.join_direct_call_room'));
  assert.ok(migration.includes('blocked users cannot share a group call'));
  assert.ok(migration.includes('blocked users cannot share a conference call'));
  assert.ok(migration.includes('v_last_seen_at >= v_left_at - interval \'30 seconds\''));
  assert.ok(migration.includes('last_seen_at = now()'));
});

test('group calls and LIVE expose authenticated heartbeats and restore stale-but-recoverable participants', () => {
  assert.ok(groupRoute.includes("router.post('/:roomId/heartbeat'"));
  assert.ok(groupRoute.includes("router.post('/:roomId/heartbeat'"));
  assert.ok(groupRoute.includes("room.source_call_id ? 'join_direct_call_room' : 'join_group_call_room'"));
  assert.ok(groupRoute.includes("update({ last_seen_at: now.toISOString() })"));
  assert.ok(liveRoute.includes("router.post('/:streamId/heartbeat'"));
  assert.ok(liveRoute.includes("rpc('join_live_stream'"));
  assert.ok(liveRoute.includes("update({ last_seen_at: now })"));
  assert.ok(index.includes('startMediaParticipantHeartbeatCleanupWorker();'));
  assert.ok(index.includes('cleanupEndedLiveRooms({ admin: supabaseAdmin })'));
});


test('LIVE polling has enough shared request budget while mutation endpoints keep tighter limits', () => {
  assert.ok(liveRoute.includes("max: 90, error: 'LIVE actions are rate-limited.'"));
  assert.ok(liveRoute.includes("max: 8, error: 'Please slow down before sending another LIVE reaction.'"));
  assert.ok(liveRoute.includes("max: 5, error: 'Please slow down before posting another LIVE comment.'"));
});


test('LIVE guest request and invitation mutations have dedicated anti-spam limits', () => {
  assert.ok(liveRoute.includes("max: 3, error: 'Please wait before requesting the LIVE stage again.'"));
  assert.ok(liveRoute.includes("max: 5, error: 'Please wait before sending more LIVE invitations.'"));
});


test('replay egress stops promptly when a LIVE stream ends before the five-minute cap', () => {
  assert.ok(replayWorker.includes('id, stream_id, egress_id, room_name, status, started_at'));
  assert.ok(replayWorker.includes("from('live_streams').select('id,status')"));
  assert.ok(replayWorker.includes('endedStreamIds.has(replay.stream_id)'));
  assert.ok(replayWorker.includes('!foundStreamIds.has(replay.stream_id)'));
});


test('LIVE end authorization is checked before stopping Egress or deleting the room', () => {
  const endStart = liveRoute.indexOf("router.post('/:streamId/end'");
  const endRoute = liveRoute.slice(endStart);
  assert.ok(endStart >= 0);
  assert.ok(endRoute.indexOf("rpc('end_live_stream'") < endRoute.indexOf('stopActiveLiveReplayForStream(streamId)'));
  assert.ok(endRoute.indexOf("rpc('end_live_stream'") < endRoute.indexOf('deleteLiveKitRoom(stream.room_name)'));
});


test('ended LIVE room cleanup waits for replay egress and then deletes the room', async () => {
  const deletedRooms = [];
  const admin = {
    from(table) {
      const query = {
        filters: {},
        select() { return this; },
        eq(key, value) { this.filters[key] = value; return this; },
        lt(key, value) { this.filters[key] = value; return this; },
        in(key, value) { this.filters[key] = value; return this; },
        limit() { return this; },
        then(resolve, reject) {
          const data = table === 'live_streams'
            ? [
              { id: 'stream-wait', room_name: 'zlive_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' },
              { id: 'stream-delete', room_name: 'zlive_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb' },
            ]
            : [{ stream_id: 'stream-wait' }];
          return Promise.resolve({ data, error: null }).then(resolve, reject);
        },
      };
      return query;
    },
  };
  const result = await worker.cleanupEndedLiveRooms({
    admin,
    deleteRoom: async (roomName) => { deletedRooms.push(roomName); },
    now: Date.parse('2026-11-15T01:00:00.000Z'),
    graceMs: 60_000,
  });
  assert.deepEqual(deletedRooms, ['zlive_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb']);
  assert.deepEqual(result, { scanned: 2, deleted: 1, waitingForReplay: 1, failed: 0 });
});

test('LiveKit room deletion accepts only generated LIVE and group room prefixes', async () => {
  const config = { url: 'wss://example.livekit.cloud', apiKey: 'key', apiSecret: 'secret' };
  await assert.rejects(roomAdmin.deleteLiveKitRoom('zlive_not-a-valid-id', { config, fetchImpl: async () => ({ ok: true, status: 200 }) }));
  await assert.rejects(roomAdmin.deleteLiveKitRoom('zgc_not-a-valid-id', { config, fetchImpl: async () => ({ ok: true, status: 200 }) }));
});
