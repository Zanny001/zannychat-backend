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
