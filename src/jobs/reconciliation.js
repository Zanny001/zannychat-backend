require('dotenv').config();
const { supabaseAdmin } = require('../config/supabaseAdmin');

// Runs on a schedule as its own Render Cron Job service (see
// render.yaml) rather than inside the web process, so a slow
// reconciliation run can never block chat traffic.
async function runReconciliation() {
  if (!supabaseAdmin) {
    console.warn('[reconciliation] skipped — Supabase is not configured.');
    return;
  }

  console.log('[reconciliation] starting run at', new Date().toISOString());

  // TODO (Phase 2): once a payment provider is connected, pull its
  // settled-transaction report for the period and compare it against
  // this project's `ledger_entries` table, flagging any mismatch.
  console.log('[reconciliation] no payment provider connected yet — nothing to reconcile.');
}

if (require.main === module) {
  runReconciliation()
    .then(() => process.exit(0))
    .catch((err) => {
      console.error('[reconciliation] failed:', err);
      process.exit(1);
    });
}

module.exports = { runReconciliation };
