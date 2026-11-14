import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const migration = fs.readFileSync(new URL('../supabase/migrations/20261114100000_live_creator_impact_score.sql', import.meta.url), 'utf8');
const routes = fs.readFileSync(new URL('../src/routes/liveStreams.js', import.meta.url), 'utf8');

test('LIVE impact awards at most one point per supporter per creator per UTC day', () => {
  assert.match(migration, /PRIMARY KEY \(creator_id, supporter_id, impact_day\)/);
  assert.match(migration, /now\(\) AT TIME ZONE 'UTC'/);
  assert.match(migration, /ON CONFLICT \(creator_id, supporter_id, impact_day\) DO NOTHING/);
});

test('LIVE impact tracks raw reactions separately from unique supporters and score', () => {
  assert.match(migration, /total_reactions bigint/);
  assert.match(migration, /unique_supporters bigint/);
  assert.match(migration, /impact_score bigint/);
  assert.match(migration, /live_creator_impact_supporters/);
});

test('LIVE impact write RPC is service-role only', () => {
  assert.match(migration, /REVOKE ALL ON FUNCTION public\.record_live_creator_impact[\s\S]*FROM PUBLIC, anon, authenticated/);
  assert.match(migration, /GRANT EXECUTE ON FUNCTION public\.record_live_creator_impact[\s\S]*TO service_role/);
});

test('LIVE reaction route persists through the transactional impact RPC', () => {
  const start = routes.indexOf("router.post('/:streamId/react'");
  const end = routes.indexOf("router.get('/:streamId/participants'", start);
  const handler = routes.slice(start, end);
  assert.match(handler, /rpc\('record_live_creator_impact'/);
  assert.doesNotMatch(handler, /from\('live_stream_reactions'\)\.insert/);
});

test('creator impact endpoint checks profile visibility and blocks before returning public stats', () => {
  const start = routes.indexOf("router.get('/creators/:creatorId/impact'");
  assert.ok(start >= 0);
  const end = routes.indexOf("router.", start + 10);
  const handler = routes.slice(start, end < 0 ? undefined : end);
  assert.match(handler, /profile_visibility/);
  assert.match(handler, /hasBlockBetween/);
  assert.match(handler, /live_creator_impact/);
});
