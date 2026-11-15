const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const route = fs.readFileSync(path.join(__dirname, '../src/routes/liveHistory.js'), 'utf8');

test('past LIVE deletion is creator-only and refuses active streams', () => {
  assert.match(route, /router\.delete\('\/:streamId'/);
  assert.match(route, /stream\.creator_id !== req\.user\.id/);
  assert.match(route, /stream\.status !== 'ended'/);
  assert.match(route, /\['starting', 'recording', 'processing'\]/);
});

test('broadcast deletion removes only replay objects under the creator and stream path', () => {
  assert.match(route, /storage\.from\('live-replays'\)\.remove\(paths\)/);
  assert.match(route, /req\.user\.id \+ '\/' \+ streamId \+ '\/'/);
  assert.match(route, /\.delete\(\)\.eq\('id', streamId\)\.eq\('creator_id', req\.user\.id\)/);
});

test('creator profile history excludes replay metadata already marked deleted', () => {
  const streamsRoute = fs.readFileSync(path.join(__dirname, '../src/routes/liveStreams.js'), 'utf8');
  assert.match(streamsRoute, /from\('live_stream_replays'\)[\s\S]*?\.neq\('status', 'deleted'\)/);
});


test('broadcast deletion removes the ended LiveKit room before deleting its database row', () => {
  assert.match(route, /deleteLiveKitRoom\(stream\.room_name\)/);
  assert.ok(route.indexOf('deleteLiveKitRoom(stream.room_name)') < route.indexOf(".delete().eq('id', streamId)"));
  assert.match(route, /select\('id,creator_id,status,room_name'\)/);
});

test('broadcast deletion releases failed/deleted replay reservations before cascade deleting rows', () => {
  assert.match(route, /rows\.filter\(\(row\) => \['failed', 'deleted'\]\.includes\(row\.status\)\)/);
  assert.match(route, /finalize_live_replay_quota/);
  assert.match(route, /p_actual_seconds: 0/);
  assert.match(route, /p_success: false/);
  assert.ok(route.indexOf('finalize_live_replay_quota') < route.indexOf("storage.from('live-replays').remove(paths)"));
});
