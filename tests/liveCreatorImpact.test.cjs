const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const migration = fs.readFileSync(path.join(__dirname, '../supabase/migrations/20261114085407_live_creator_impact_score.sql'), 'utf8');
const routes = fs.readFileSync(path.join(__dirname, '../src/routes/liveStreams.js'), 'utf8');

test('LIVE impact awards at most one point per supporter per creator per UTC day', () => {
  assert.ok(migration.includes('PRIMARY KEY (creator_id, supporter_id, impact_day)'));
  assert.ok(migration.includes("now() AT TIME ZONE 'UTC'"));
  assert.ok(migration.includes('ON CONFLICT (creator_id, supporter_id, impact_day) DO NOTHING'));
});

test('LIVE impact tracks raw reactions separately from unique supporters and score', () => {
  assert.ok(migration.includes('total_reactions bigint'));
  assert.ok(migration.includes('unique_supporters bigint'));
  assert.ok(migration.includes('impact_score bigint'));
  assert.ok(migration.includes('live_creator_impact_supporters'));
});

test('LIVE impact write RPC is service-role only', () => {
  assert.ok(migration.includes('REVOKE ALL ON FUNCTION public.record_live_creator_impact(uuid, uuid, text) FROM PUBLIC, anon, authenticated'));
  assert.ok(migration.includes('GRANT EXECUTE ON FUNCTION public.record_live_creator_impact(uuid, uuid, text) TO service_role'));
});

test('LIVE reaction route persists through the transactional impact RPC', () => {
  const start = routes.indexOf("router.post('/:streamId/react'");
  const end = routes.indexOf("router.get('/:streamId/participants'", start);
  const handler = routes.slice(start, end);
  assert.ok(handler.includes("rpc('record_live_creator_impact'"));
  assert.equal(handler.includes("from('live_stream_reactions').insert"), false);
});

test('creator impact endpoint delegates to a fail-closed profile and block visibility guard', () => {
  const start = routes.indexOf("router.get('/creators/:creatorId/impact'");
  assert.ok(start >= 0);
  const end = routes.indexOf('router.', start + 10);
  const handler = routes.slice(start, end < 0 ? undefined : end);
  const guardStart = routes.indexOf('async function canViewCreatorImpact');
  const guardEnd = routes.indexOf('\nasync function ', guardStart + 10);
  const guard = routes.slice(guardStart, guardEnd < 0 ? undefined : guardEnd);
  assert.ok(handler.includes('canViewCreatorImpact'));
  assert.ok(handler.includes('live_creator_impact'));
  assert.ok(guard.includes('profile_visibility'));
  assert.ok(guard.includes('hasBlockBetween'));
  assert.ok(guard.includes('conversation_participants'));
  assert.ok(guard.includes("visibility !== 'contacts') return false"));
});

const creatorReactionMigration = fs.readFileSync(path.join(__dirname, '../supabase/migrations/20261114224335_allow_creator_live_reactions_without_self_impact.sql'), 'utf8');

test('LIVE creators can react on their own broadcast without awarding themselves impact', () => {
  const start = creatorReactionMigration.indexOf('CREATE OR REPLACE FUNCTION public.record_live_creator_impact');
  const end = creatorReactionMigration.indexOf('CREATE OR REPLACE FUNCTION public.get_live_creator_reaction_breakdown', start);
  assert.ok(start >= 0 && end > start, 'creator reaction RPC migration is present');
  const body = creatorReactionMigration.slice(start, end);
  const reactionInsert = body.indexOf('INSERT INTO public.live_stream_reactions');
  const creatorBranch = body.indexOf('IF v_creator_id = p_user_id THEN');
  assert.ok(reactionInsert >= 0 && creatorBranch > reactionInsert, 'creator reaction is persisted before impact handling');
  assert.match(body, /SELECT COALESCE\(i\.impact_score, 0\)/);
  assert.match(body, /false\s+FROM \(SELECT 1\) AS anchor/);
  assert.match(body, /RETURN;/);
  assert.doesNotMatch(body, /Creators cannot award themselves impact/);
  assert.match(body, /p\.status = 'joined'/, 'non-creator viewers still need an active joined participant row');
});
