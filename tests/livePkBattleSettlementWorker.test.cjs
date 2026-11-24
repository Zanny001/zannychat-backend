const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {
  SETTLEMENT_INTERVAL_MS,
  STARTUP_DELAY_MS,
  DEFAULT_BATCH_SIZE,
  runLivePkBattleSettlement,
} = require('../src/jobs/livePkBattleSettlementWorker');

test('PK settlement worker calls the service-role settlement RPC with a bounded batch size', async () => {
  let call = null;
  const admin = {
    rpc: async (name, args) => {
      call = { name, args };
      return { data: 3, error: null };
    },
  };
  const summary = await runLivePkBattleSettlement({ admin, batchSize: 25 });
  assert.deepEqual(call, {
    name: 'reconcile_live_pk_battle_settlement',
    args: { p_limit: 25 },
  });
  assert.deepEqual(summary, { skipped: false, reconciled: 3 });
});

test('PK settlement worker fails closed when Supabase is unavailable', async () => {
  const summary = await runLivePkBattleSettlement({ admin: null });
  assert.deepEqual(summary, {
    skipped: true,
    reason: 'supabase_not_configured',
    reconciled: 0,
  });
});

test('PK settlement worker uses a short startup warmup and bounded interval', () => {
  assert.equal(SETTLEMENT_INTERVAL_MS, 30 * 1000);
  assert.equal(STARTUP_DELAY_MS, 8 * 1000);
  assert.equal(DEFAULT_BATCH_SIZE, 100);
});

test('backend startup wires the PK settlement worker into the production process', () => {
  const index = fs.readFileSync(path.join(__dirname, '../src/index.js'), 'utf8');
  assert.match(index, /require\('\.\/jobs\/livePkBattleSettlementWorker'\)/);
  assert.match(index, /startLivePkBattleSettlementWorker\(\)/);
});
