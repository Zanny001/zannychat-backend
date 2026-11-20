const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const liveRoutes = fs.readFileSync(path.join(__dirname, '../src/routes/liveStreams.js'), 'utf8');
const webhookRoute = fs.readFileSync(path.join(__dirname, '../src/routes/livekitEgressWebhook.js'), 'utf8');
const worker = fs.readFileSync(path.join(__dirname, '../src/jobs/liveReplayWorker.js'), 'utf8');
const finalizer = fs.readFileSync(path.join(__dirname, '../src/services/liveReplayFinalizer.js'), 'utf8');

test('only the live creator can start and stop a replay, and only during an active stream', () => {
  assert.match(liveRoutes, /router\.post\('\/:streamId\/replays\/start'/);
  assert.match(liveRoutes, /isLiveReplayEnabled\(\)/);
  assert.match(liveRoutes, /stream\.creator_id !== req\.user\.id/);
  assert.match(liveRoutes, /stream\.status !== 'live'/);
  assert.match(liveRoutes, /get_live_replay_storage_bytes/);
  assert.match(liveRoutes, /storageCapBytes/);
  assert.match(liveRoutes, /reserve_live_replay_quota/);
  assert.match(liveRoutes, /startRoomCompositeEgress/);
  assert.match(liveRoutes, /scheduleLiveReplayStop\(replayId, egressId, now\)/);
  assert.match(liveRoutes, /room_name: stream\.room_name/);
  assert.match(liveRoutes, /router\.post\('\/:streamId\/replays\/:replayId\/stop'/);
  assert.match(liveRoutes, /replay\.creator_id !== req\.user\.id/);
  assert.match(liveRoutes, /stopEgress/);
});

test('replay listing and playback preserve stream visibility, blocks, and creator removal revocation', () => {
  assert.match(liveRoutes, /async function canViewLiveReplay/);
  assert.match(liveRoutes, /hasBlockBetween\(stream\.creator_id, userId\)/);
  const accessStart = liveRoutes.indexOf('async function canViewLiveReplay');
  const accessEnd = liveRoutes.indexOf('async function stopActiveLiveReplayForStream', accessStart);
  const accessGuard = liveRoutes.slice(accessStart, accessEnd);
  assert.match(accessGuard, /\.select\('id,status'\)/);
  assert.match(accessGuard, /participant\?\.status === 'blocked'/);
  assert.ok(accessGuard.indexOf("participant?.status === 'blocked'") < accessGuard.indexOf("stream.visibility === 'public'"), 'creator removal must revoke replay access before public/visibility shortcuts');
  assert.match(liveRoutes, /stream\.visibility === 'public'/);
  assert.match(liveRoutes, /stream\.visibility === 'followers'/);
  assert.match(liveRoutes, /live_creator_follows/);
  assert.match(liveRoutes, /stream\.visibility === 'private'/);
  assert.match(liveRoutes, /live_stream_invites/);
  assert.match(liveRoutes, /router\.get\('\/replays'/);
  assert.match(liveRoutes, /stream:live_streams/);
  assert.match(liveRoutes, /canViewLiveReplay\(replay\.stream, req\.user\.id\)/);
  assert.match(liveRoutes, /router\.get\('\/:streamId\/replays'/);
  assert.match(liveRoutes, /router\.get\('\/replays\/:replayId\/playback'/);
  assert.match(liveRoutes, /createSignedUrl\(replay\.file_path, 360\)/);
  assert.doesNotMatch(liveRoutes, /getPublicUrl\(replay\.file_path/);
});

test('creator can delete only completed replay files and stream end stops active Egress', () => {
  assert.match(liveRoutes, /router\.delete\('\/replays\/:replayId'/);
  assert.match(liveRoutes, /Only the creator can delete this replay/);
  assert.match(liveRoutes, /\['starting', 'recording', 'processing'\]/);
  assert.match(liveRoutes, /stopActiveLiveReplayForStream\(streamId\)/);
  const stopHelper = liveRoutes.indexOf('async function stopActiveLiveReplayForStream');
  const configGuard = liveRoutes.indexOf('if (!egressConfig) return;', stopHelper);
  const replayLookup = liveRoutes.indexOf("from('live_stream_replays')", stopHelper);
  assert.ok(configGuard > stopHelper && replayLookup > configGuard, 'stream end must not query replay tables before Egress is configured');
});

test('Egress webhook verifies raw signed payloads and validates output before marking ready', () => {
  assert.match(webhookRoute, /express\.raw\(\{ type: \['application\/webhook\+json', 'application\/json'\]/);
  assert.match(webhookRoute, /verifyLiveKitWebhook/);
  assert.match(webhookRoute, /event\?\.event !== 'egress_ended'/);
  assert.match(webhookRoute, /finalizeReplay/);
  assert.match(finalizer, /size <= MAX_REPLAY_BYTES/);
  assert.match(finalizer, /durationSeconds <= MAX_REPLAY_OUTPUT_SECONDS/);
  assert.match(finalizer, /status: 'ready'/);
  assert.match(finalizer, /clearLiveReplayStop/);
  assert.match(finalizer, /sendPushToUser/);
  assert.match(finalizer, /live_replay_ready/);
  assert.match(finalizer, /notification_sent_at/);
});

test('server worker stops expired recordings and deletes expired private objects', () => {
  assert.match(worker, /RECOVERY_SCAN_MS = 60 \* 1000/);
  assert.match(worker, /MAX_REPLAY_SECONDS \* 1000/);
  assert.match(worker, /stopEgress/);
  assert.match(worker, /scheduleLiveReplayStop/);
  assert.match(worker, /STOP_RETRY_MS/);
  assert.match(worker, /CLEANUP_SCAN_MS/);
  assert.match(worker, /live-replays/);
  assert.match(worker, /\.eq\('status', 'processing'\)/);
});

test('a replay start that cannot be found during recovery is failed and releases its reservation', () => {
  assert.match(worker, /status: 'failed',[\s\S]*error_code: 'EGRESS_NOT_FOUND'/);
  assert.match(worker, /finalize_live_replay_quota/);
  assert.match(worker, /p_success: false/);
  assert.match(worker, /START_RECOVERY_GRACE_MS/);
});

test('LIVE replay credential diagnostics are authenticated, rate-limited, and read-only', () => {
  assert.match(liveRoutes, /router\.post\('\/replays\/config\/validate', replayConfigValidationLimiter/);
  assert.match(liveRoutes, /windowMs: 5 \* 60 \* 1000/);
  assert.match(liveRoutes, /max: 3/);
  assert.match(liveRoutes, /validateReplayCredentials\(replayConfig\)/);
  assert.match(liveRoutes, /LIVEKIT_REPLAY_BUILD_PLAN_CONFIRMED/);
  assert.match(liveRoutes, /SUPABASE_STORAGE_S3_ENDPOINT/);
  assert.match(liveRoutes, /LIVEKIT_REPLAY_WEBHOOK_URL/);
  assert.match(liveRoutes, /secret values are never returned/);
  assert.match(liveRoutes, /ListEgress \+ S3 ListObjectsV2/);
});

test('deleting a failed or already-deleted replay releases any outstanding reservation immediately', () => {
  const start = liveRoutes.indexOf("router.delete('/replays/:replayId'");
  const end = liveRoutes.indexOf("\n});", start) + 4;
  const body = liveRoutes.slice(start, end);
  assert.match(body, /\['failed', 'deleted'\]\.includes\(replay\.status\)/);
  assert.match(body, /finalize_live_replay_quota/);
  assert.match(body, /p_actual_seconds: 0/);
  assert.match(body, /p_success: false/);
});


test('Egress webhook uses nanosecond-aware duration recovery before accepting a replay', () => {
  assert.match(finalizer, /getEgressDurationSeconds\(file, info\)/);
  assert.match(finalizer, /durationSeconds <= MAX_REPLAY_OUTPUT_SECONDS/);
  assert.doesNotMatch(finalizer, /function getDurationSeconds\(file\)/);
});


test('completed Egress records are reconciled when the signed completion webhook is lost', () => {
  assert.match(worker, /async function reconcileCompletedLiveReplays/);
  assert.match(worker, /active: false/);
  assert.match(worker, /egressId: replay\.egress_id/);
  assert.match(worker, /finalizeReplay\(\{ event: 'egress_ended', egressInfo: info \}\)/);
  assert.match(worker, /startup completed Egress reconciliation/);
  assert.match(worker, /completed Egress reconciliation/);
});

test('an Egress start without a persisted id is matched by its exact replay output path before failing', () => {
  assert.match(worker, /function getEgressOutputPaths/);
  assert.match(worker, /function matchesReplayEgress/);
  assert.match(worker, /active: false/);
  assert.match(worker, /isTerminalEgressStatus\(found\.status\)/);
  assert.match(worker, /await finalizeReplay\(\{ event: 'egress_ended', egressInfo: found \}\)/);
});
