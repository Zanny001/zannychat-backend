const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const workflow = fs.readFileSync(
  path.join(__dirname, '../.github/workflows/durable-worker-claim-leases-migration.yml'),
  'utf8',
);

test('guarded worker/index migration workflow excludes the five SQL-verified LIVE migration aliases', () => {
  for (const filename of [
    '20261119180000_live_creator_preferences.sql',
    '20261119200000_live_events.sql',
    '20261119210000_fix_live_event_reminder_claim_ambiguity.sql',
    '20261119220000_live_stream_hard_timeout.sql',
    '20261120150000_live_replay_notification_claims.sql',
  ]) {
    assert.ok(workflow.includes("! -name '" + filename + "'"), filename + ' must not be replayed');
  }
  assert.ok(workflow.includes('20261119184056'));
  assert.ok(workflow.includes('20261119204054'));
  assert.ok(workflow.includes('20261119205846'));
  assert.ok(workflow.includes('20261119220130'));
  assert.ok(workflow.includes('20261120232530'));
});

test('guarded production workflow still requires exactly the three remaining migrations and explicit confirmation', () => {
  assert.match(workflow, /confirm_production_apply/);
  assert.match(workflow, /if: inputs\.confirm_production_apply == true/);
  assert.match(workflow, /20261120120000 20261120130000 20261120140000 \| sort/);
  assert.match(workflow, /20261120140000/);
  assert.match(workflow, /supabase db push --dry-run --linked/);
  assert.match(workflow, /supabase db push --linked --yes/);
  assert.match(workflow, /environment: production/);
});
