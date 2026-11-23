const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const assert = require('node:assert/strict');

const migration = fs.readFileSync(
  path.join(__dirname, '../supabase/migrations/20261123213000_live_gift_append_only_reward_rule_fix.sql'),
  'utf8',
);

test('creator reward rule is snapshotted in the original append-only gift transaction insert', () => {
  assert.match(migration, /SELECT \* INTO v_rule FROM public\.live_creator_reward_rules[\s\S]*FOR SHARE/);
  assert.match(migration, /battle_id, reward_rule_id,[\s\S]*v_effective_battle_id, v_rule\.id/);
  assert.match(migration, /replace\(v_definition, v_old_insert, v_new_insert\)/);
  assert.match(migration, /replace\(v_updated_definition, v_old_rule, v_new_rule\)/);
  assert.match(migration, /IF v_rule\.id IS NOT NULL AND v_eligible_gross > 0/);
});

test('the migration preserves append-only audit enforcement and refuses unexpected source rewrites', () => {
  assert.match(migration, /append-only audit trigger/);
  assert.match(migration, /send_live_gift definition differs from the audited source/);
  assert.match(migration, /send_live_gift still attempts to mutate the append-only gift audit row/);
  assert.match(migration, /did not persist reward_rule_id in its initial insert/);
});
