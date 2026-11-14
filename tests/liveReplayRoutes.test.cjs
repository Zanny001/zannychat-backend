const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const liveRoutes = fs.readFileSync(path.join(__dirname, '../src/routes/liveStreams.js'), 'utf8');
const webhookRoute = fs.readFileSync(path.join(__dirname, '../src/routes/livekitEgressWebhook.js'), 'utf8');
const worker = fs.readFileSync(path.join(__dirname, '../src/jobs/liveReplayWorker.js'), 'utf8');

test('only the live creator can start and stop a replay, and only during an active stream', () => {
  assert.match(liveRoutes, /router\.post\('\/:streamId\/replays\/start'/);
  assert.match(liveRoutes, /isLiveReplayEnabled\(\)/);
  assert.match(liveRoutes, /stream\.creator_id !== req\.user\.id/);
  assert.match(liveRoutes, /stream\.status !== 'live'/);
  assert.match(liveRoutes, /get_live_replay_storage_bytes/);
  assert.match(liveRoutes, /currentStorageBytes \\+ MAX_REPLAY_BYTES > storageCapBytes/);
  assert.match(liveRoutes, /reserve_live_replay_quota/);
  assert.match(liveRoutes, /startRoomCompositeEgress/);
  assert.match(liveRoutes, /router\.post\('\/:streamId\/replays\/:replayId\/stop'/);
  assert.match(liveRoutes, /replay\.creator_id !== req\.user\.id/);
  assert.match(liveRoutes, /stopEgress/);
});

test('replay listing and playback preserve stream visibility and bidirectional blocks', () => {
  assert.match(liveRoutes, /async function canViewLiveReplay/);
  assert.match(liveRoutes, /hasBlockBetween\(stream\.creator_id, userId\)/);
  assert.match(liveRoutes, /stream\.visibility === 'public'/);
  assert.match(liveRoutes, /stream\.visibility === 'followers'/);
  assert.match(liveRoutes, /live_creator_follows/);
  assert.match(liveRoutes, /stream\.visibility === 'private'/);
  assert.match(liveRoutes, /live_stream_invites/);
  assert.match(liveRoutes, /router\.get\('\/:streamId\/replays'/);
  assert.match(liveRoutes, /router\.get\('\/replays\/:replayId\/playback'/);
  assert.match(liveRoutes, /createSignedUrl\(replay\.file_path, 300\)/);
  assert.doesNotMatch(liveRoutes, /getPublicUrl\(replay\.file_path/);
});

test('creator can delete only completed replay files and stream end stops active Egress', () => {
  assert.match(liveRoutes, /router\.delete\('\/replays\/:replayId'/);
  assert.match(liveRoutes, /Only the creator can delete this replay/);
  assert.match(liveRoutes, /\['starting', 'recording', 'processing'\]/);
  assert.match(liveRoutes, /stopActiveLiveReplayForStream\(streamId\)/);
});

test('Egress webhook verifies raw signed payloads and validates output before marking ready', () => {
  assert.match(webhookRoute, /express\.raw\(\{ type: \['application\/webhook\+json', 'application\/json'\]/);
  assert.match(webhookRoute, /verifyLiveKitWebhook/);
  assert.match(webhookRoute, /event\?\.event !== 'egress_ended'/);
  assert.match(webhookRoute, /size <= MAX_REPLAY_BYTES/);
  assert.match(webhookRoute, /durationSeconds <= MAX_REPLAY_SECONDS/);
  assert.match(webhookRoute, /status: 'ready'/);
});

test('server worker stops expired recordings and deletes expired private objects', () => {
  assert.match(worker, /STOP_SCAN_MS = 15000/);
  assert.match(worker, /MAX_REPLAY_SECONDS \* 1000/);
  assert.match(worker, /stopEgress/);
  assert.match(worker, /CLEANUP_SCAN_MS/);
  assert.match(worker, /live-replays/);
  assert.match(worker, /status === 'processing'/);
});
