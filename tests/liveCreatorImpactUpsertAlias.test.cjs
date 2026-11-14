const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const migration = fs.readFileSync(path.join(__dirname, '../supabase/migrations/20261114151000_fix_live_creator_impact_upsert_alias.sql'), 'utf8');

test('LIVE creator impact upsert declares the target alias used by conflict updates', () => {
  assert.ok(migration.includes('INSERT INTO public.live_creator_impact AS current_impact'));
  assert.ok(migration.includes('impact_score = current_impact.impact_score + EXCLUDED.impact_score'));
  assert.ok(migration.includes('total_reactions = current_impact.total_reactions + 1'));
  assert.ok(migration.includes('unique_supporters = current_impact.unique_supporters + EXCLUDED.unique_supporters'));
});

test('LIVE impact writer preserves service-role-only execution', () => {
  assert.ok(migration.includes('REVOKE ALL ON FUNCTION public.record_live_creator_impact(uuid, uuid, text) FROM PUBLIC, anon, authenticated'));
  assert.ok(migration.includes('GRANT EXECUTE ON FUNCTION public.record_live_creator_impact(uuid, uuid, text) TO service_role'));
});
