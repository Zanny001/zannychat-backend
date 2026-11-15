const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const route = fs.readFileSync(path.join(__dirname, '../src/routes/liveStreams.js'), 'utf8');
const start = route.indexOf("router.get('/:streamId/comments'");
const end = route.indexOf("router.post('/:streamId/comment'", start);
const comments = route.slice(start, end);

test('LIVE comments exclude authors blocked in either direction by the requesting viewer', () => {
  assert.match(comments, /getBlockedUserIds\(req\.user\.id, ordered\.map\(\(comment\) => comment\.user_id\)\)/);
  assert.match(comments, /ordered\.filter\(\(comment\) => !blockedCommenterIds\.has\(comment\.user_id\)\)/);
  assert.match(comments, /getProfileNames\(visibleComments\.map\(\(comment\) => comment\.user_id\)\)/);
});

test('LIVE floating reactions exclude blocked actors and never expose actor identifiers', () => {
  assert.match(comments, /select\('id,user_id,reaction,created_at'\)/);
  assert.match(comments, /getBlockedUserIds\(req\.user\.id, \(recentReactions \|\| \[\]\)\.map\(\(reaction\) => reaction\.user_id\)\)/);
  assert.match(comments, /filter\(\(reaction\) => !blockedReactionUserIds\.has\(reaction\.user_id\)\)/);
  assert.match(comments, /map\(\(\{ user_id: _userId, \.\.\.reaction \}\) => reaction\)/);
});
