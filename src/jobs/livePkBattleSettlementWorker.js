const { supabaseAdmin } = require('../config/supabaseAdmin');

const SETTLEMENT_INTERVAL_MS = 30 * 1000;
const STARTUP_DELAY_MS = 8 * 1000;
const DEFAULT_BATCH_SIZE = 100;
let started = false;

async function runLivePkBattleSettlement({
  admin = supabaseAdmin,
  batchSize = DEFAULT_BATCH_SIZE,
} = {}) {
  if (!admin) return { skipped: true, reason: 'supabase_not_configured', reconciled: 0 };
  const { data, error } = await admin.rpc('reconcile_live_pk_battle_settlement', {
    p_limit: batchSize,
  });
  if (error) throw error;
  return { skipped: false, reconciled: Number(data || 0) };
}

function startLivePkBattleSettlementWorker() {
  if (started || !supabaseAdmin) return null;
  started = true;
  let running = false;

  const tick = async () => {
    if (running) return;
    running = true;
    try {
      const summary = await runLivePkBattleSettlement();
      if (!summary.skipped && summary.reconciled > 0) {
        console.info('[live-battles] settlement batch', summary);
      }
    } catch (error) {
      console.error('[live-battles] settlement worker failed:', error?.message || error);
    } finally {
      running = false;
    }
  };

  const timer = setInterval(tick, SETTLEMENT_INTERVAL_MS);
  const warmup = setTimeout(tick, STARTUP_DELAY_MS);
  timer.unref?.();
  warmup.unref?.();
  return timer;
}

module.exports = {
  SETTLEMENT_INTERVAL_MS,
  STARTUP_DELAY_MS,
  DEFAULT_BATCH_SIZE,
  runLivePkBattleSettlement,
  startLivePkBattleSettlementWorker,
};
