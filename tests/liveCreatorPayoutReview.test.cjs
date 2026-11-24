const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const route = fs.readFileSync(path.join(__dirname, '../src/routes/liveCreatorPayoutReview.js'), 'utf8');
const migration = fs.readFileSync(
  path.join(__dirname, '../supabase/migrations/20261124005000_live_creator_payout_review_workflow.sql'),
  'utf8',
);
const index = fs.readFileSync(path.join(__dirname, '../src/index.js'), 'utf8');

test('payout review administration is disabled without an explicit UUID allowlist', () => {
  assert.match(route, /LIVE_PAYOUT_ADMIN_USER_IDS/);
  assert.match(route, /allowed\.size === 0/);
  assert.match(route, /return res\.status\(503\)/);
  assert.match(route, /allowed\.has\(String\(req\.user\?\.id/);
});

test('the access probe reveals only the current authenticated user allowlist result', () => {
  assert.match(route, /router\.get\('\/access'/);
  assert.match(route, /isAdmin: payoutReviewAdminIds\(\)\.has\(String\(req\.user\?\.id/);
});

test('only allowlisted admins can access the queue and submit verification decisions', () => {
  assert.match(route, /router\.get\('\/queue', requirePayoutReviewAdmin/);
  assert.match(route, /router\.post\('\/:creatorId', requirePayoutReviewAdmin/);
  assert.match(route, /verificationReference\.trim\(\)/);
  assert.match(route, /payoutHold/);
});

test('verification approvals require an evidence provider and reference', () => {
  assert.match(route, /verificationProvider\.trim\(\)\.length < 2/);
  assert.match(route, /verificationReference\.trim\(\)\.length < 3/);
  assert.match(migration, /new_status <> 'verified'/);
  assert.match(migration, /verification_reference/);
});

test('review decisions and reviewer identity are stored in a service-role-only append-only audit', () => {
  assert.match(migration, /reviewed_by uuid NOT NULL/);
  assert.match(migration, /live_creator_payout_review_audit_append_only/);
  assert.match(migration, /REVOKE ALL ON public\.live_creator_payout_review_audit[\s\S]*FROM PUBLIC, anon, authenticated/);
  assert.match(migration, /REVOKE ALL ON FUNCTION public\.review_live_creator_payout_profile[\s\S]*FROM PUBLIC, anon, authenticated/);
  assert.match(migration, /GRANT EXECUTE ON FUNCTION public\.review_live_creator_payout_profile[\s\S]*TO service_role/);
});

test('admin payout review route is mounted behind authentication', () => {
  assert.match(index, /app\.use\('\/live\/admin\/payout-review', liveCreatorPayoutReviewRouter\)/);
});
