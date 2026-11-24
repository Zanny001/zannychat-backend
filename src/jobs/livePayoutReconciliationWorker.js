const { supabaseAdmin } = require('../config/supabaseAdmin');
const { reconcilePendingCreatorPayouts } = require('../services/livePayoutReconciliation');

const RECONCILIATION_INTERVAL_MS = 60 * 1000;
const STARTUP_DELAY_MS = 10 * 1000;
let started = false;

async function runLivePayoutReconciliation({
  admin = supabaseAdmin,
  reconcile = reconcilePendingCreatorPayouts,
} = {}) {
  if (!admin) return { skipped: true, reason: 'supabase_not_configured' };
  return reconcile({ supabase: admin });
}

function startLivePayoutReconciliationWorker() {
  if (started || !supabaseAdmin) return null;
  started = true;
  let running = false;

  const tick = async () => {
    if (running) return;
    running = true;
    try {
      const summary = await runLivePayoutReconciliation();
      if (!summary.skipped && (summary.scanned || summary.errors)) {
        console.info('[live-payouts] reconciliation batch', summary);
      }
    } catch (error) {
      console.error('[live-payouts] reconciliation worker failed:', error?.message || error);
    } finally {
      running = false;
    }
  };

  const timer = setInterval(tick, RECONCILIATION_INTERVAL_MS);
  const warmup = setTimeout(tick, STARTUP_DELAY_MS);
  timer.unref?.();
  warmup.unref?.();
  return timer;
}

module.exports = {
  RECONCILIATION_INTERVAL_MS,
  STARTUP_DELAY_MS,
  runLivePayoutReconciliation,
  startLivePayoutReconciliationWorker,
};
