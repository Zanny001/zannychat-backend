const test = require('node:test');
const assert = require('node:assert/strict');
const { notifyReplayReady } = require('../src/services/liveReplayFinalizer');

function createSharedState({ rowExists = true, status = 'ready', notificationSentAt = null } = {}) {
  return {
    rowExists,
    status,
    notificationSentAt,
    notificationClaimedAt: null,
    notificationClaimToken: null,
    tokenCounter: 0,
  };
}

function createFakeAdmin(state) {
  return {
    async rpc(name, args) {
      assert.ok(args.p_replay_id === 'replay-1');
      if (name === 'claim_live_replay_ready_notification') {
        if (!state.rowExists || state.status !== 'ready' || state.notificationSentAt || state.notificationClaimToken) {
          return { data: null, error: null };
        }
        state.tokenCounter += 1;
        const token = 'claim-' + state.tokenCounter;
        state.notificationClaimToken = token;
        state.notificationClaimedAt = Date.now();
        return { data: token, error: null };
      }
      if (name === 'complete_live_replay_ready_notification') {
        if (state.notificationClaimToken !== args.p_claim_token || state.notificationSentAt) return { data: false, error: null };
        state.notificationSentAt = new Date().toISOString();
        state.notificationClaimedAt = null;
        state.notificationClaimToken = null;
        return { data: true, error: null };
      }
      if (name === 'release_live_replay_ready_notification') {
        if (state.notificationClaimToken !== args.p_claim_token || state.notificationSentAt) return { data: false, error: null };
        state.notificationClaimedAt = null;
        state.notificationClaimToken = null;
        return { data: true, error: null };
      }
      throw new Error('Unexpected RPC: ' + name);
    },
  };
}

const replay = {
  id: 'replay-1',
  creator_id: 'creator-1',
  stream_id: 'stream-1',
  notification_sent_at: null,
};

test('separate backend instances cannot claim the same replay-ready notification concurrently', async () => {
  const state = createSharedState();
  const firstAdmin = createFakeAdmin(state);
  const secondAdmin = createFakeAdmin(state);
  let sends = 0;
  let releaseSend;
  const sendGate = new Promise((resolve) => { releaseSend = resolve; });
  const sendPush = async () => { sends += 1; await sendGate; };

  const first = notifyReplayReady(replay, { admin: firstAdmin, sendPush });
  await Promise.resolve();
  assert.equal(sends, 1);

  await notifyReplayReady(replay, { admin: secondAdmin, sendPush });
  assert.equal(sends, 1);

  releaseSend();
  await first;
  assert.equal(sends, 1);
  assert.ok(state.notificationSentAt);
  assert.equal(state.notificationClaimToken, null);
});

test('a stale replay object does not resend after the durable sent marker is set', async () => {
  const state = createSharedState();
  const admin = createFakeAdmin(state);
  let sends = 0;
  const sendPush = async () => { sends += 1; };

  await notifyReplayReady(replay, { admin, sendPush });
  await notifyReplayReady(replay, { admin, sendPush });
  assert.equal(sends, 1);
});

test('a replay already marked as notified is skipped without claiming', async () => {
  const state = createSharedState({ notificationSentAt: '2026-11-20T00:00:00.000Z' });
  let sends = 0;
  await notifyReplayReady({ ...replay, notification_sent_at: state.notificationSentAt }, {
    admin: createFakeAdmin(state), sendPush: async () => { sends += 1; },
  });
  assert.equal(sends, 0);
});

test('a removed or non-ready replay is not notified', async () => {
  for (const state of [createSharedState({ rowExists: false }), createSharedState({ status: 'processing' })]) {
    let sends = 0;
    await notifyReplayReady(replay, { admin: createFakeAdmin(state), sendPush: async () => { sends += 1; } });
    assert.equal(sends, 0);
  }
});

test('failed push delivery releases its claim so a later worker can retry', async () => {
  const state = createSharedState();
  const admin = createFakeAdmin(state);
  await assert.rejects(
    notifyReplayReady(replay, { admin, sendPush: async () => { throw new Error('push unavailable'); } }),
    /push unavailable/,
  );
  assert.equal(state.notificationClaimToken, null);
  assert.equal(state.notificationClaimedAt, null);

  let sends = 0;
  await notifyReplayReady(replay, { admin, sendPush: async () => { sends += 1; } });
  assert.equal(sends, 1);
  assert.ok(state.notificationSentAt);
});
