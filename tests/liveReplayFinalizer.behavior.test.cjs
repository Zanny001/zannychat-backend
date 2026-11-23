const test = require('node:test');
const assert = require('node:assert/strict');
const { finalizeReplay } = require('../src/services/liveReplayFinalizer');

function makeQuery(result) {
  const query = {
    select() { return query; },
    update() { return query; },
    eq() { return query; },
    in() { return query; },
    order() { return query; },
    limit() { return query; },
    maybeSingle: async () => result,
    then(resolve, reject) { return Promise.resolve(result).then(resolve, reject); },
  };
  return query;
}

function makeAdmin({ replay, updateError }) {
  const calls = { updates: [], rpcs: [] };
  return {
    calls,
    from(table) {
      assert.equal(table, 'live_stream_replays');
      return {
        select() { return makeQuery({ data: replay, error: null }); },
        update(values) {
          calls.updates.push(values);
          return makeQuery({ data: null, error: updateError || null });
        },
      };
    },
    async rpc(name, args) {
      calls.rpcs.push({ name, args });
      return { data: true, error: null };
    },
    storage: { from() { return { remove: async () => ({ error: null }) }; } },
  };
}

const replay = {
  id: 'replay-1',
  file_path: 'creator/stream/replay.mp4',
  status: 'recording',
  duration_seconds: 0,
  room_name: 'room-1',
  creator_id: 'creator-1',
  stream_id: 'stream-1',
  notification_sent_at: null,
};

const completedEvent = {
  event: 'egress_ended',
  egressInfo: {
    egressId: 'egress-1',
    status: 'EGRESS_COMPLETE',
    fileResults: [{
      filename: 'creator/stream/replay.mp4',
      size: 1024,
      duration: '5000000000',
    }],
  },
};

test('finalizer propagates a failed ready-state write and does not settle quota or notify', async () => {
  const admin = makeAdmin({ replay, updateError: new Error('database write unavailable') });
  let notified = false;
  await assert.rejects(
    finalizeReplay(completedEvent, {
      admin,
      clearStop() {},
      sendPush: async () => { notified = true; return { sent: 1 }; },
    }),
    /database write unavailable/,
  );
  assert.equal(admin.calls.updates.length, 1);
  assert.equal(admin.calls.rpcs.length, 0);
  assert.equal(notified, false);
});

test('finalizer does not report an invalid-output failure when failed-state persistence fails', async () => {
  const admin = makeAdmin({ replay, updateError: new Error('failed-state write unavailable') });
  const invalidEvent = {
    ...completedEvent,
    egressInfo: { ...completedEvent.egressInfo, fileResults: [] },
  };
  await assert.rejects(
    finalizeReplay(invalidEvent, { admin, clearStop() {} }),
    /failed-state write unavailable/,
  );
  assert.equal(admin.calls.updates.length, 1);
  assert.equal(admin.calls.rpcs.length, 0);
});

test('finalizer does not continue after Egress-id recovery cannot be persisted', async () => {
  const calls = { updates: [], rpcs: [] };
  let selects = 0;
  const admin = {
    from() {
      return {
        select() {
          selects += 1;
          return makeQuery(selects === 1
            ? { data: null, error: null }
            : { data: replay, error: null });
        },
        update(values) {
          calls.updates.push(values);
          return makeQuery({ data: null, error: new Error('egress-id write unavailable') });
        },
      };
    },
    async rpc(name, args) { calls.rpcs.push({ name, args }); return { data: true, error: null }; },
  };
  const event = {
    ...completedEvent,
    egressInfo: { ...completedEvent.egressInfo, roomName: 'room-1' },
  };
  await assert.rejects(
    finalizeReplay(event, { admin, clearStop() {} }),
    /egress-id write unavailable/,
  );
  assert.equal(calls.updates.length, 1);
  assert.equal(calls.rpcs.length, 0);
});
