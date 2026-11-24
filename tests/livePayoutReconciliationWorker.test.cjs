const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {
  RECONCILIATION_INTERVAL_MS,
  STARTUP_DELAY_MS,
  runLivePayoutReconciliation,
} = require('../src/jobs/livePayoutReconciliationWorker');

test('payout reconciliation worker delegates to the verified Paystack reconciliation service', async () => {
  const admin = { marker: 'service-role-client' };
  let received = null;
  const summary = await runLivePayoutReconciliation({
    admin,
    reconcile: async (input) => {
      received = input;
      return { skipped: false, scanned: 2, reconciled: 1, pending: 1, errors: 0 };
    },
  });
  assert.deepEqual(received, { supabase: admin });
  assert.deepEqual(summary, { skipped: false, scanned: 2, reconciled: 1, pending: 1, errors: 0 });
});

test('payout reconciliation worker fails closed when Supabase is unavailable', async () => {
  const summary = await runLivePayoutReconciliation({ admin: null });
  assert.deepEqual(summary, { skipped: true, reason: 'supabase_not_configured' });
});

test('payout reconciliation worker runs on a bounded interval with a short startup warmup', () => {
  assert.equal(RECONCILIATION_INTERVAL_MS, 60 * 1000);
  assert.equal(STARTUP_DELAY_MS, 10 * 1000);
});

test('backend startup wires the payout reconciliation worker into the production process', () => {
  const index = fs.readFileSync(path.join(__dirname, '../src/index.js'), 'utf8');
  assert.match(index, /require\('\.\/jobs\/livePayoutReconciliationWorker'\)/);
  assert.match(index, /startLivePayoutReconciliationWorker\(\)/);
});
