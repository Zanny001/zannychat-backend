require('dotenv').config();
const { supabaseAdmin } = require('../config/supabaseAdmin');
const { reconcilePendingCreatorPayouts } = require('../services/livePayoutReconciliation');

async function runReconciliation() {
  if (!supabaseAdmin) {
    console.warn('[reconciliation] skipped — Supabase is not configured.');
    return { skipped: true, reason: 'supabase_not_configured' };
  }
  if (!process.env.PAYSTACK_SECRET_KEY) {
    console.warn('[reconciliation] skipped — Paystack is not configured.');
    return { skipped: true, reason: 'paystack_not_configured' };
  }

  console.log('[reconciliation] starting payout verification at', new Date().toISOString());
  return reconcilePendingCreatorPayouts({ supabase: supabaseAdmin });
}

if (require.main === module) {
  runReconciliation()
    .then((summary) => {
      if (summary?.errors > 0) process.exitCode = 1;
      process.exitCode = process.exitCode || 0;
    })
    .catch((err) => {
      console.error('[reconciliation] failed:', err?.message || err);
      process.exitCode = 1;
    });
}

module.exports = { runReconciliation };
