const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const migration = fs.readFileSync(
  path.join(__dirname, '../supabase/migrations/20261120150000_live_replay_notification_claims.sql'),
  'utf8',
);
const finalizer = fs.readFileSync(
  path.join(__dirname, '../src/services/liveReplayFinalizer.js'),
  'utf8',
);
const worker = fs.readFileSync(
  path.join(__dirname, '../src/jobs/liveReplayWorker.js'),
  'utf8',
);

test('replay notification claims are durable, expiring and token-bound', () => {
  assert.match(migration, /notification_claimed_at timestamptz/);
  assert.match(migration, /notification_claim_token uuid/);
  assert.match(migration, /notification_retry_after timestamptz/);
  assert.match(migration, /notification_retry_after IS NULL OR notification_retry_after <= now\(\)/);
  assert.match(migration, /notification_retry_after = now\(\) \+ interval '10 minutes'/);
  assert.match(migration, /notification_claimed_at < now\(\) - interval '10 minutes'/);
  assert.match(migration, /notification_claim_token = p_claim_token/);
  assert.match(migration, /notification_sent_at IS NULL/);
});

test('replay notification claim RPCs are service-role-only and use a pinned search path', () => {
  for (const signature of [
    'claim_live_replay_ready_notification(uuid)',
    'complete_live_replay_ready_notification(uuid, uuid)',
    'release_live_replay_ready_notification(uuid, uuid)',
  ]) {
    assert.ok(migration.includes('REVOKE ALL ON FUNCTION public.' + signature + ' FROM PUBLIC, anon, authenticated'));
    assert.ok(migration.includes('GRANT EXECUTE ON FUNCTION public.' + signature + ' TO service_role'));
  }
  assert.equal((migration.match(/SET search_path TO ''/g) || []).length, 3);
});

test('replay notification sender claims before push and completes only after delivery', () => {
  const claim = finalizer.indexOf("admin.rpc('claim_live_replay_ready_notification'");
  const push = finalizer.indexOf('await sendPush(replay.creator_id');
  const complete = finalizer.indexOf("admin.rpc('complete_live_replay_ready_notification'");
  const release = finalizer.indexOf("admin.rpc('release_live_replay_ready_notification'");
  assert.ok(claim >= 0 && push > claim && complete > push && release > complete);
  assert.match(finalizer, /Number\(delivery\.sent \|\| 0\) < 1/);
  assert.doesNotMatch(finalizer, /replayReadyNotificationsInFlight/);
});


test('worker periodically retries ready replays whose notification marker is still empty', () => {
  assert.match(worker, /async function deliverPendingReplayReadyNotifications/);
  assert.match(worker, /\.eq\('status', 'ready'\)/);
  assert.match(worker, /\.is\('notification_sent_at', null\)/);
  assert.match(worker, /startup pending replay-ready notifications/);
  assert.match(worker, /setInterval\(\(\) => safeRun\('pending replay-ready notifications'/);
});
