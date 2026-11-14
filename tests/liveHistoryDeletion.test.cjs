const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');

const route = fs.readFileSync(new URL('../src/routes/liveHistory.js', import.meta.url), 'utf8');

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
