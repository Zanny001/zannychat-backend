const test = require('node:test');
const assert = require('node:assert/strict');
const { notifyReplayReady } = require('../src/services/liveReplayFinalizer');

function createFakeAdmin({ rowExists = true } = {}) {
  let notificationSentAt = null;
  return {
    get notificationSentAt() { return notificationSentAt; },
    from(table) {
      assert.equal(table, 'live_stream_replays');
      const query = {
        patch: null,
        select() { return this; },
        update(patch) { this.patch = patch; return this; },
        eq(column, value) {
          assert.equal(column, 'id');
          assert.equal(value, 'replay-1');
          return this;
        },
        maybeSingle: async () => ({ data: rowExists ? { notification_sent_at: notificationSentAt } : null, error: null }),
        is: async (column, value) => {
          assert.equal(column, 'notification_sent_at');
          assert.equal(value, null);
          if (notificationSentAt === null) notificationSentAt = query.patch.notification_sent_at;
          return { error: null };
        },
      };
      return query;
    },
  };
}

const replay = {
  id: 'replay-1',
  creator_id: 'creator-1',
  stream_id: 'stream-1',
  notification_sent_at: null,
};

test('concurrent replay finalizers send one ready notification within a process', async () => {
  const admin = createFakeAdmin();
  let sends = 0;
  let releaseSend;
  const sendGate = new Promise((resolve) => { releaseSend = resolve; });
  const sendPush = async () => {
    sends += 1;
    await sendGate;
  };

  const first = notifyReplayReady(replay, { admin, sendPush });
  const second = notifyReplayReady(replay, { admin, sendPush });
  await Promise.resolve();
  assert.equal(sends, 1);
  releaseSend();
  await Promise.all([first, second]);
  assert.equal(sends, 1);
  assert.ok(admin.notificationSentAt);
});

test('a stale replay object does not resend after the database marker is set', async () => {
  const admin = createFakeAdmin();
  let sends = 0;
  const sendPush = async () => { sends += 1; };

  await notifyReplayReady(replay, { admin, sendPush });
  await notifyReplayReady(replay, { admin, sendPush });
  assert.equal(sends, 1);
});

test('a replay already marked as notified is skipped', async () => {
  const admin = createFakeAdmin();
  let sends = 0;
  await notifyReplayReady({ ...replay, notification_sent_at: '2026-11-20T00:00:00.000Z' }, {
    admin, sendPush: async () => { sends += 1; },
  });
  assert.equal(sends, 0);
});


test('a replay removed during finalization is not notified', async () => {
  const admin = createFakeAdmin({ rowExists: false });
  let sends = 0;
  await notifyReplayReady(replay, { admin, sendPush: async () => { sends += 1; } });
  assert.equal(sends, 0);
});
