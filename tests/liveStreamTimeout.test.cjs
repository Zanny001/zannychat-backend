const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const worker = require('../src/jobs/liveStreamTimeoutWorker');

const migration = fs.readFileSync(
  path.join(__dirname, '../supabase/migrations/20261119220000_live_stream_hard_timeout.sql'),
  'utf8',
);
const index = fs.readFileSync(path.join(__dirname, '../src/index.js'), 'utf8');
const heartbeatMigration = fs.readFileSync(
  path.join(__dirname, '../supabase/migrations/20261115014920_media_participant_heartbeat_leases.sql'),
  'utf8',
);

test('LIVE has a four-hour server-enforced hard maximum and a ten-minute warning window', () => {
  assert.equal(worker.LIVE_STREAM_MAX_DURATION_SECONDS, 4 * 60 * 60);
  assert.equal(worker.LIVE_STREAM_WARNING_SECONDS, 10 * 60);
  assert.match(migration, /started_at <= now\(\) - interval '4 hours'/);
  assert.match(migration, /started_at <= now\(\) - interval '3 hours 50 minutes'/);
  assert.match(migration, /timeout_warning_sent_at IS NULL/);
});

test('hard timeout ends connected creators too while preserving stale-heartbeat cleanup', () => {
  assert.match(migration, /s\.started_at <= now\(\) - interval '4 hours'\s+OR EXISTS/);
  assert.match(migration, /creator\.last_seen_at < p_stale_before/);
  assert.match(migration, /status = 'ended', ended_at = COALESCE\(s\.ended_at, now\(\)\)/);
  assert.match(migration, /REVOKE ALL ON FUNCTION public\.cleanup_stale_media_participants\(timestamptz\) FROM PUBLIC, anon, authenticated/);
  assert.match(migration, /GRANT EXECUTE ON FUNCTION public\.cleanup_stale_media_participants\(timestamptz\) TO service_role/);
  assert.match(heartbeatMigration, /CREATE OR REPLACE FUNCTION public\.cleanup_stale_media_participants/);
});

test('timeout warning claim is atomic and service-role-only', () => {
  assert.match(migration, /UPDATE public\.live_streams AS s/);
  assert.match(migration, /SET timeout_warning_sent_at = now\(\)/);
  assert.match(migration, /timeout_warning_sent_at IS NULL/);
  assert.match(migration, /REVOKE ALL ON FUNCTION public\.claim_live_stream_timeout_warnings\(\) FROM PUBLIC, anon, authenticated/);
  assert.match(migration, /GRANT EXECUTE ON FUNCTION public\.claim_live_stream_timeout_warnings\(\) TO service_role/);
});

test('warning worker sends one creator-only push per atomically claimed stream', async () => {
  const calls = [];
  const summary = await worker.runLiveStreamTimeoutWarnings({
    admin: { rpc: async (name) => ({
      data: name === 'claim_live_stream_timeout_warnings'
        ? [{ recipient_id: 'creator-1', broadcast_id: 'stream-1', broadcast_title: 'Test LIVE' }]
        : [],
      error: null,
    }) },
    send: async (userId, notification) => {
      calls.push({ userId, notification });
      return { sent: 1 };
    },
  });
  assert.deepEqual(summary, { claimed: 1, sent: 1, failed: 0 });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].userId, 'creator-1');
  assert.equal(calls[0].notification.data.type, 'live_stream_timeout_warning');
  assert.equal(calls[0].notification.data.streamId, 'stream-1');
});

test('backend starts the warning worker alongside stale participant and replay cleanup', () => {
  assert.match(index, /startLiveStreamTimeoutWarningWorker\(\)/);
  assert.match(index, /startMediaParticipantHeartbeatCleanupWorker\(\)/);
  assert.match(index, /startLiveReplayWorker\(\)/);
});
