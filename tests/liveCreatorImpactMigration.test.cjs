const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const migration = fs.readFileSync(path.join(__dirname, '../supabase/migrations/20261114124217_live_creator_reaction_breakdown.sql'), 'utf8');
const route = fs.readFileSync(path.join(__dirname, '../src/routes/liveStreams.js'), 'utf8');

test('creator reaction collection aggregates all reactions by stream owner without exposing the RPC to clients', () => {
  assert.ok(migration.includes('public.live_stream_reactions'));
  assert.ok(migration.includes('public.live_streams'));
  assert.ok(migration.includes('streams.creator_id = p_creator_id'));
  assert.ok(migration.includes("jsonb_build_object('reaction', reaction_counts.reaction, 'count', reaction_counts.reaction_count)"));
  assert.ok(migration.includes('REVOKE ALL ON FUNCTION public.get_live_creator_reaction_breakdown(uuid) FROM PUBLIC'));
  assert.ok(migration.includes('TO service_role'));
});

test('creator impact route returns reaction collection, earned badges and next milestone', () => {
  assert.ok(route.includes("'get_live_creator_reaction_breakdown'"));
  assert.ok(route.includes('reactionBreakdown: Array.isArray(reactionBreakdown)'));
  assert.ok(route.includes('nextMilestone'));
  assert.ok(route.includes("label: 'Legendary Presence'"));
  assert.ok(route.includes("label: 'Hall of Fame'"));
});
