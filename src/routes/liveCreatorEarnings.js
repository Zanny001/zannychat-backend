const express = require('express');
const { requireAuth } = require('../middleware/requireAuth');
const { makeLimiter } = require('../middleware/rateLimit');
const { supabaseAdmin } = require('../config/supabaseAdmin');

const router = express.Router();
router.use(requireAuth, makeLimiter({ windowMs: 60 * 1000, max: 30, error: 'Creator earnings requests are rate-limited.' }));

router.get('/summary', async (req, res) => {
  try {
    const { data, error } = await supabaseAdmin.rpc('get_live_creator_earnings_summary', {
      p_creator_id: req.user.id,
    });
    if (error) throw error;
    return res.json({ earnings: data || {
      currency: 'NGN',
      pendingMinor: 0,
      availableMinor: 0,
      heldMinor: 0,
      lifetimeNetMinor: 0,
      paidOutMinor: 0,
      processingPayoutMinor: 0,
      minimumWithdrawalMinor: null,
      earningEnabled: false,
    } });
  } catch (error) {
    console.error('[live-creator-earnings] summary lookup failed:', error?.message || error);
    return res.status(503).json({ error: 'Creator earnings are temporarily unavailable' });
  }
});

router.get('/history', async (req, res) => {
  try {
    const { data, error } = await supabaseAdmin.from('live_creator_earnings_ledger')
      .select('id,entry_type,gross_minor,platform_fee_minor,net_minor,currency,status,available_at,created_at,stream_id')
      .eq('creator_id', req.user.id).order('created_at', { ascending: false }).limit(50);
    if (error) throw error;
    return res.json({ entries: data || [] });
  } catch (error) {
    console.error('[live-creator-earnings] history lookup failed:', error?.message || error);
    return res.status(503).json({ error: 'Creator earnings history is temporarily unavailable' });
  }
});

module.exports = router;
