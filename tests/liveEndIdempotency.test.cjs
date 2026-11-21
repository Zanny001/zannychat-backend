const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const route = fs.readFileSync(path.join(__dirname, '../src/routes/liveStreams.js'), 'utf8');
const start = route.indexOf("router.post('/:streamId/end', async (req, res) =>");
const end = route.indexOf('\n});', start) + 4;
const endRoute = route.slice(start, end);

test('creator retry after an already-committed LIVE end is idempotent and retries SFU cleanup', () => {
  const creatorGuard = endRoute.indexOf('stream.creator_id !== req.user.id');
  const endedBranch = endRoute.indexOf("if (stream.status === 'ended')");
  const replayCleanup = endRoute.indexOf('stopActiveLiveReplayForStream(streamId)', endedBranch);
  const roomCleanup = endRoute.indexOf('deleteLiveKitRoom(stream.room_name)', endedBranch);
  const success = endRoute.indexOf('alreadyEnded: true', endedBranch);
  assert.ok(creatorGuard >= 0 && endedBranch > creatorGuard);
  assert.ok(replayCleanup > endedBranch && roomCleanup > replayCleanup && success > roomCleanup);
  assert.match(endRoute, /if \(stream\.status !== 'live'\) return res\.status\(404\)/);
});

test('concurrent LIVE end retries re-read the stream before reporting failure', () => {
  const rpc = endRoute.indexOf("rpc('end_live_stream'");
  const falseResult = endRoute.indexOf('if (!ended)', rpc);
  const reread = endRoute.indexOf('await getStream(streamId)', falseResult);
  const success = endRoute.indexOf('alreadyEnded: true', falseResult);
  assert.ok(rpc >= 0 && falseResult > rpc && reread > falseResult && success > reread);
});
