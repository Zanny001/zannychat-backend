const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const migration = fs.readFileSync(path.join(__dirname, '../supabase/migrations/20261114160810_backfill_live_creator_impact_history_20261114150000.sql'), 'utf8');
const packageJson = JSON.parse(fs.readFileSync(path.join(__dirname, '../package.json'), 'utf8'));

test('historical LIVE reactions are backfilled only up to the original impact-ledger cutoff', () => {
  assert.ok(migration.includes("created_at < timestamptz '2026-11-14 08:54:07+00'"));
  assert.ok(migration.includes('streams.creator_id <> reactions.user_id'));
  assert.ok(migration.includes('JOIN public.live_streams'));
});

test('historical creator impact counts every reaction but awards at most one point per supporter per UTC day', () => {
  assert.ok(migration.includes('count(*)::bigint AS total_reactions'));
  assert.ok(migration.includes('SELECT DISTINCT creator_id, supporter_id, impact_day'));
  assert.ok(migration.includes('ON CONFLICT (creator_id, supporter_id, impact_day) DO NOTHING'));
  assert.ok(migration.includes('count(*)::bigint AS impact_score'));
});

test('historical backfill increments any existing live ledger rather than overwriting it', () => {
  assert.ok(migration.includes('INSERT INTO public.live_creator_impact AS current_impact'));
  assert.ok(migration.includes('current_impact.impact_score + EXCLUDED.impact_score'));
  assert.ok(migration.includes('current_impact.total_reactions + EXCLUDED.total_reactions'));
});

test('the primary LIVE test command includes creator-impact behavior and history backfill tests', () => {
  assert.ok(packageJson.scripts['test:live-streams'].includes('liveCreatorImpact.test.cjs'));
  assert.ok(packageJson.scripts['test:live-streams'].includes('liveCreatorImpactMigration.test.cjs'));
  assert.ok(packageJson.scripts['test:live-streams'].includes('liveCreatorImpactHistoryBackfill.test.cjs'));
});
