const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const migration = fs.readFileSync(path.join(__dirname, '../supabase/migrations/20261114150000_backfill_live_creator_impact_history.sql'), 'utf8');
const packageJson = JSON.parse(fs.readFileSync(path.join(__dirname, '../package.json'), 'utf8'));

test('historical LIVE reactions are backfilled only up to the original impact-ledger cutoff', () => {
  assert.match(migration, /created_at < timestamptz '2026-11-14 08:54:07\\+00'/);
  assert.match(migration, /streams\\.creator_id <> reactions\\.user_id/);
  assert.match(migration, /JOIN public\\.live_streams/);
});

test('historical creator impact counts every reaction but awards at most one point per supporter per UTC day', () => {
  assert.match(migration, /count\\(\\*\\)::bigint AS total_reactions/);
  assert.match(migration, /SELECT DISTINCT creator_id, supporter_id, impact_day/);
  assert.match(migration, /ON CONFLICT \\(creator_id, supporter_id, impact_day\\) DO NOTHING/);
  assert.match(migration, /SELECT creator_id, count\\(\\*\\)::bigint AS impact_score/);
});

test('historical backfill increments any existing live ledger rather than overwriting it', () => {
  assert.match(migration, /ON CONFLICT \\(creator_id\\) DO UPDATE SET/);
  assert.match(migration, /public\\.live_creator_impact\\.impact_score \\+ EXCLUDED\\.impact_score/);
  assert.match(migration, /public\\.live_creator_impact\\.total_reactions \\+ EXCLUDED\\.total_reactions/);
});

test('the primary LIVE test command includes creator-impact behavior and history backfill tests', () => {
  assert.match(packageJson.scripts['test:live-streams'], /liveCreatorImpact\\.test\\.cjs/);
  assert.match(packageJson.scripts['test:live-streams'], /liveCreatorImpactMigration\\.test\\.cjs/);
  assert.match(packageJson.scripts['test:live-streams'], /liveCreatorImpactHistoryBackfill\\.test\\.cjs/);
});
