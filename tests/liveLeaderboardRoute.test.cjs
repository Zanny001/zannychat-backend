const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const route = fs.readFileSync(path.join(__dirname, '../src/routes/liveStreams.js'), 'utf8');
const start = route.indexOf("router.get('/leaderboard'");
const end = route.indexOf("router.get('/creators/me/profile'", start);
const leaderboard = route.slice(start, end);

test('LIVE leaderboard is authenticated and supports only the period the backend can prove', () => {
  assert.ok(route.includes("router.use(requireAuth"));
  assert.ok(leaderboard.includes("router.get('/leaderboard'"));
  assert.ok(leaderboard.includes("period !== 'all_time'"));
  assert.ok(leaderboard.includes('Only all-time LIVE rankings are currently available.'));
  assert.ok(leaderboard.includes('Math.min(Math.max(requestedLimit, 1), 50)'));
});

test('LIVE leaderboard ranks real creator impact aggregates with deterministic tie-breaking', () => {
  assert.ok(leaderboard.includes(".from('live_creator_impact')"));
  assert.ok(leaderboard.includes(".order('impact_score', { ascending: false })"));
  assert.ok(leaderboard.includes(".order('total_reactions', { ascending: false })"));
  assert.ok(leaderboard.includes(".order('unique_supporters', { ascending: false })"));
  assert.ok(leaderboard.includes(".order('creator_id', { ascending: true })"));
  assert.ok(leaderboard.includes('.limit(200)'));
  assert.ok(leaderboard.includes('rank: index + 1'));
});

test('LIVE leaderboard excludes private/contact-only profiles and either-direction blocks', () => {
  assert.ok(leaderboard.includes(".from('profile_details').select('user_id,profile_visibility')"));
  assert.ok(leaderboard.includes("visibility === 'everyone'"));
  assert.ok(leaderboard.includes('getBlockedUserIds(req.user.id, creatorIds)'));
  assert.ok(route.includes(".from('blocked_users').select('blocked_id').eq('blocker_id', userId)"));
  assert.ok(route.includes(".from('blocked_users').select('blocker_id').eq('blocked_id', userId)"));
  assert.ok(leaderboard.includes('!blockedIds.has(row.creator_id)'));
});

test('LIVE leaderboard returns only public creator ranking fields', () => {
  for (const field of ['creatorId', 'name', 'avatarColor', 'impactScore', 'totalReactions', 'uniqueSupporters', 'updatedAt']) {
    assert.ok(leaderboard.includes(field), 'Missing public leaderboard field: ' + field);
  }
  assert.equal(leaderboard.includes('phone'), false);
  assert.equal(leaderboard.includes('email'), false);
  assert.equal(leaderboard.includes('profile_visibility:'), false);
});
