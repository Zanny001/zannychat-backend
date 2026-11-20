const test = require('node:test');
const assert = require('node:assert/strict');
const { deliverPendingReplayReadyNotifications } = require('../src/jobs/liveReplayWorker');

function createFakeAdmin(rows) {
  const calls = [];
  return {
    calls,
    from(table) {
      assert.equal(table, 'live_stream_replays');
      const query = {
        select(columns) { calls.push(['select', columns]); return this; },
        eq(column, value) { calls.push(['eq', column, value]); return this; },
        is(column, value) { calls.push(['is', column, value]); return this; },
        order(column, options) { calls.push(['order', column, options]); return this; },
        limit(value) { calls.push(['limit', value]); return Promise.resolve({ data: rows, error: null }); },
      };
      return query;
    },
  };
}

test('pending replay-ready notification recovery scans only ready rows without a sent marker', async () => {
  const rows = [
    { id: 'replay-1', creator_id: 'creator-1', stream_id: 'stream-1', notification_sent_at: null },
    { id: 'replay-2', creator_id: 'creator-2', stream_id: 'stream-2', notification_sent_at: null },
  ];
  const admin = createFakeAdmin(rows);
  const notified = [];
  const result = await deliverPendingReplayReadyNotifications({
    admin,
    notify: async (row) => { notified.push(row.id); return { sent: true }; },
  });
  assert.deepEqual(notified, ['replay-1', 'replay-2']);
  assert.deepEqual(result, { scanned: 2, notified: 2 });
  assert.ok(admin.calls.some((call) => call[0] === 'eq' && call[1] === 'status' && call[2] === 'ready'));
  assert.ok(admin.calls.some((call) => call[0] === 'is' && call[1] === 'notification_sent_at' && call[2] === null));
  assert.ok(admin.calls.some((call) => call[0] === 'limit' && call[1] === 25));
});

test('one failed replay-ready notification does not block retrying later rows', async () => {
  const admin = createFakeAdmin([
    { id: 'replay-1', creator_id: 'creator-1', stream_id: 'stream-1', notification_sent_at: null },
    { id: 'replay-2', creator_id: 'creator-2', stream_id: 'stream-2', notification_sent_at: null },
  ]);
  const attempted = [];
  const result = await deliverPendingReplayReadyNotifications({
    admin,
    notify: async (row) => {
      attempted.push(row.id);
      if (row.id === 'replay-1') throw new Error('temporary push failure');
      return { sent: true };
    },
  });
  assert.deepEqual(attempted, ['replay-1', 'replay-2']);
  assert.deepEqual(result, { scanned: 2, notified: 1 });
});
