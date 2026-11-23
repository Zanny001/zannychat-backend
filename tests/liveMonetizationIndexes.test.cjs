const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const assert = require('node:assert/strict');

const migration = fs.readFileSync(
  path.join(__dirname, '../supabase/migrations/20261123220000_live_monetization_fk_indexes.sql'),
  'utf8',
);

test('all newly introduced LIVE monetization foreign keys have covering indexes', () => {
  assert.match(migration, /live_creator_earnings_ledger\(gift_transaction_id\)/);
  assert.match(migration, /live_creator_earnings_ledger\(reward_rule_id\)/);
  assert.match(migration, /live_creator_payouts\(beneficiary_id\)/);
  assert.match(migration, /live_creator_reward_rules\(created_by\)/);
});
