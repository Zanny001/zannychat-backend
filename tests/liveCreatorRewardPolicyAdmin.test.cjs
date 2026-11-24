const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const route = fs.readFileSync(path.join(__dirname, '../src/routes/liveCreatorRewardPolicy.js'), 'utf8');
const migration = fs.readFileSync(path.join(__dirname, '../supabase/migrations/20261124020000_live_creator_reward_policy_admin.sql'), 'utf8');
const index = fs.readFileSync(path.join(__dirname, '../src/index.js'), 'utf8');

test('reward policy administration is fail-closed behind a dedicated UUID allowlist', () => {
  assert.match(route, /LIVE_ECONOMY_ADMIN_USER_IDS/);
  assert.match(route, /allowed\.size === 0/);
  assert.match(route, /return res\.status\(503\)/);
  assert.match(route, /allowed\.has\(String\(req\.user\?\.id/);
  assert.match(route, /router\.get\('\/access'/);
});

test('reward policy drafts validate basis points, clearance hours and NGN minor units', () => {
  assert.match(route, /creatorShareBps < 1 \|\| creatorShareBps > 10000/);
  assert.match(route, /clearanceHours < 0 \|\| clearanceHours > 720/);
  assert.match(route, /minimumWithdrawalMinor <= 0/);
  assert.match(migration, /is_active, created_by\)[\s\S]*false, p_admin_id/);
});

test('only explicit activation confirmation can activate a rule through the service-role RPC', () => {
  assert.match(route, /ACTIVATE_CREATOR_REWARD_RULE/);
  assert.match(route, /activate_live_creator_reward_rule/);
  assert.match(migration, /REVOKE ALL ON FUNCTION public\.activate_live_creator_reward_rule[\s\S]*FROM PUBLIC, anon, authenticated/);
  assert.match(migration, /GRANT EXECUTE ON FUNCTION public\.activate_live_creator_reward_rule[\s\S]*TO service_role/);
});

test('reward rule changes are recorded in a service-role-only append-only audit', () => {
  assert.match(migration, /live_creator_reward_rule_audit/);
  assert.match(migration, /BEFORE UPDATE OR DELETE/);
  assert.match(migration, /REVOKE ALL ON public\.live_creator_reward_rule_audit[\s\S]*FROM PUBLIC, anon, authenticated/);
  assert.match(migration, /action, previous_rule_id, rule_id/);
});

test('reward policy admin route is mounted behind authentication', () => {
  assert.match(index, /app\.use\('\/live\/admin\/reward-policy', liveCreatorRewardPolicyRouter\)/);
});
