const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const route = fs.readFileSync(path.join(__dirname, '../src/routes/channels.js'), 'utf8');
const migration = fs.readFileSync(path.join(__dirname, '../supabase/migrations/0056_channel_comment_reports.sql'), 'utf8');

test('channel comment reports validate reason, access, authorship, and duplicate submissions', () => {
  const start = route.indexOf("router.post('/:channelId/posts/:postId/comments/:commentId/reports'");
  const end = route.indexOf("router.get('/:channelId/reports'", start);
  assert.ok(start >= 0 && end > start);
  const handler = route.slice(start, end);
  assert.match(handler, /CHANNEL_REPORT_REASONS\.has\(reason\)/);
  assert.match(handler, /requireChannelAccess\(res, channel, req\.user\.id\)/);
  assert.match(handler, /You cannot report your own comment/);
  assert.match(handler, /You have already reported this comment/);
  assert.match(handler, /comment_id: comment\.id/);
});

test('channel moderation report schema permits exactly one post or comment target and prevents duplicate reports', () => {
  assert.match(migration, /alter column post_id drop not null/i);
  assert.match(migration, /channel_post_reports_exactly_one_target/);
  assert.match(migration, /channel_post_reports_comment_reporter_unique/);
  assert.match(migration, /channel_comment_reports_open_idx/);
});

test('channel report review returns comment context as well as post context', () => {
  assert.match(route, /commentMap\.get\(row\.comment_id\)/);
  assert.match(route, /reportType: row\.comment_id \? 'comment' : 'post'/);
});


test('channel report review uses a stable bounded cursor so older reports remain reachable', () => {
  const start = route.indexOf("router.get('/:channelId/reports'");
  const end = route.indexOf("router.patch('/:channelId/reports/:reportId'", start);
  const handler = route.slice(start, end);
  assert.match(handler, /const pageSize = 50/);
  assert.match(handler, /cursorCreatedAt/);
  assert.match(handler, /cursorId/);
  assert.match(handler, /Invalid report pagination cursor/);
  assert.match(handler, /\\d\{4\}-\\d\{2\}-\\d\{2\}T/);
  assert.match(handler, /order\('created_at', \{ ascending: true \}\)\.order\('id', \{ ascending: true \}\)/);
  assert.match(handler, /hasMore, nextCursor/);
});
